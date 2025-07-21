import * as dotenv from "dotenv";
dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
import express from "express";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { formatDateLocal, isFilledArray, isValidNumber } from "./ts/helpers";
import {
    Department,
    Restaurant,
    Settings,
    Step,
    CommentContainer,
    GetCommentsReq,
} from "./ts/types";
import {
    ensureSettingsFile,
    readJsonFile,
    writeJsonFile,
    ensureCache,
    sendInlineKeyboard,
    sendSkipCancel,
    clearPrevious,
} from "./ts/utils";

const { BOT_TOKEN, WEBHOOK_URL, PORT = "3000", API } = process.env;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!WEBHOOK_URL) throw new Error("WEBHOOK_URL is required");
if (!API) throw new Error("API is required");
const API_BASE = API;
const STORAGE_PATH = path.resolve(process.cwd(), "settings.json");
const PORT_NUM = Number(PORT);
const CHECK_INTERVAL = 3_600_000;
const DEFAULT_PAGE_SIZE = 5;

const bot = new Telegraf(BOT_TOKEN);
const sessionCache = new Map<
    string,
    { depts?: Department[]; restaurants?: Restaurant[] }
>();
const userSettings = new Map<string, Settings>();
const commentsFlowStep = new Map<string, Step>();
const userPage = new Map<string, number>();
const userMessages = new Map<string, number[]>();

const commentsCache = new Map<string, Record<string, CommentContainer[]>>();

async function initStorage() {
    await ensureSettingsFile(STORAGE_PATH);
    const data = await readJsonFile<Record<string, Settings>>(STORAGE_PATH);
    Object.entries(data).forEach(([chatId, f]) => userSettings.set(chatId, f));
}
// Сохранить userSettings в файл
async function persistSettings() {
    const obj: Record<string, Settings> = {};
    userSettings.forEach((f, chatId) => (obj[chatId] = f));
    await writeJsonFile(STORAGE_PATH, obj);
}

// Получить или инициализировать фильтры для chatId
function getOrInitSettings(chatId: string): Settings {
    let f = userSettings.get(chatId);
    if (!f) {
        f = {
            department_ids: [],
            page_size: String(DEFAULT_PAGE_SIZE),
            lastChecked: new Date(0).toISOString(),
        };
        userSettings.set(chatId, f);
    }
    return f;
}

// Утилита для простого fetch
async function fetchJSON<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
}
const fetchDepartments = () =>
    fetchJSON<Department[]>(`${API_BASE}/departments/`);
const fetchRestaurants = () =>
    fetchJSON<Restaurant[]>(`${API_BASE}/restaurants/`);
function getCommentsUrl(params: GetCommentsReq) {
    //TO DO FIX TYPES
    return `${API_BASE}/comments/?${new URLSearchParams(
        params as unknown as Record<string, string>
    )}`;
}

// Основные клавиатуры
const mainKeyboard = Markup.keyboard([
    ["/comments — Показать отзывы"],
    ["/settings — Показать или изменить фильтры"],
]).resize();

const cancelBtn = Markup.button.callback("❌ Отмена", "cancel");
const skipBtn = Markup.button.callback("⏭️ Пропустить", "skip");

// Обработчик ошибок бота
bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    ctx.reply("Произошла неожиданная ошибка");
});

// Пошаговая логика ввода фильтров
async function nextStep(ctx: any) {
    const chatId = String(ctx.chat.id);
    const step = commentsFlowStep.get(chatId) ?? Step.Preview;
    try {
        switch (step) {
            case Step.Preview: {
                const f = getOrInitSettings(chatId);
                if (isFilledArray(f.department_ids)) {
                    await ctx.reply(
                        `Текущие фильтры:\nДепартаменты: ${f.department_ids.join(
                            ", "
                        )}\nДаты: ${f.created_at_after ? "С" + f.created_at_after : ""} ${f.created_at_before ? "До" + f.created_at_before : ""}\nЗвезды: ${f.stars || "Все"}\nРесторан: ${f.restaurant_id || "Все"
                        }\nКоличество отзывов на страницу: ${f.page_size}`,
                        mainKeyboard
                    );
                }
                return sendInlineKeyboard(ctx, "Настроить фильтры?", [
                    Markup.button.callback("Да", "skip"),
                    cancelBtn,
                ]);
            }
            case Step.Department: {
                const depts = await ensureCache(
                    sessionCache,
                    chatId,
                    "depts",
                    fetchDepartments
                );
                const f = getOrInitSettings(chatId);
                const buttons = depts.map((d) => {
                    const isSel = f.department_ids.includes(String(d.id));
                    const text = `${isSel ? "✅ " : ""}${d.name}`;
                    return Markup.button.callback(text, `dept_toggle:${d.id}`);
                });
                buttons.push(
                    Markup.button.callback("✔️ Готово", "dept_done"),
                    cancelBtn
                );
                return sendInlineKeyboard(
                    ctx,
                    "Шаг 1: Выберите департамент(ы):",
                    buttons
                );
            }
            case Step.Dates:
                return sendSkipCancel(
                    ctx,
                    "Шаг 2: Пропустите шаг или введите даты в формате:\n\nYYYY-MM-DD:YYYY-MM-DD для диапазона\n\nYYYY-MM-DD — только дата начала\n\n:YYYY-MM-DD — только дата конца.",
                    skipBtn,
                    cancelBtn
                );
            case Step.Stars:
                return sendSkipCancel(
                    ctx,
                    "Шаг 3: Пропустите шаг или введите количество звезд, поставленных пользователем, одним числом от 1 до 5",
                    skipBtn,
                    cancelBtn
                );
            /*
                                                                  case Step.Restaurant: {
                                                                      const rests = await ensureCache(
                                                                          sessionCache,
                                                                          chatId,
                                                                          "restaurants",
                                                                          fetchRestaurants
                                                                      );
                                                                      return sendInlineKeyboard(
                                                                          ctx,
                                                                          "Шаг 4: Выберите ресторан:",
                                                                          rests
                                                                              .map((r) => Markup.button.callback(r.name, `rest:${r.id}`))
                                                                              .concat(skipBtn, cancelBtn)
                                                                      );
                                                                  }
                                                                  */
            case Step.PageSize:
                return sendSkipCancel(
                    ctx,
                    "Шаг 4: Введите количество выводимых отзывов на страницу (по умолчанию 5)",
                    skipBtn,
                    cancelBtn
                );
            default:
                await ctx.reply("Пожалуйста, подождите, получаем отзывы...");
                await persistSettings();
                return fetchAndSend(ctx, 1);
        }
    } catch (e) {
        console.error("nextStep error:", e);
        await ctx.reply("Ошибка шага ввода фильтра. Начните заново.");
        commentsFlowStep.delete(chatId);
    }
}

async function fetchAndSend(ctx: any, page: number) {
    const chatId = String(ctx.chat.id);
    const f = getOrInitSettings(chatId);
    const cacheKey = `page_${page}`;

    let deptContainers = commentsCache.get(chatId)?.[cacheKey];
    if (!deptContainers) {
        deptContainers = await Promise.all(
            f.department_ids.map(async (deptId) => {
                const params: GetCommentsReq = {
                    department_id: deptId,
                    page: String(page),
                    page_size: f.page_size,
                    ...(f.created_at_after && { created_at_after: f.created_at_after }),
                    ...(f.created_at_before && { created_at_before: f.created_at_before }),
                    ...(f.stars && { stars: f.stars.join(",") }),
                    ...(f.restaurant_id && { restaurant: f.restaurant_id }),
                };
                console.log(params);
                return fetchJSON<CommentContainer>(getCommentsUrl(params));
            })
        );
        // Сохраняем в кеш
        if (!commentsCache.has(chatId)) commentsCache.set(chatId, {});
        commentsCache.get(chatId)![cacheKey] = deptContainers;
    }

    // Объединяем результаты
    const allResults = deptContainers.flatMap((c) => c.results ?? []);
    if (!isFilledArray(allResults)) {
        return ctx.reply("Отзывы отсутствуют");
    }

    // Очистка предыдущих и отправка новых
    await clearPrevious(ctx, userMessages, chatId);
    userPage.set(chatId, page);
    const sentIds: number[] = [];

    for (const c of allResults) {
        const msg = await bot.telegram.sendMessage(
            chatId,
            `${c.restaurant.type_comments_loader}\n${"★".repeat(c.stars)}\n` +
            `Ресторан: ${c.restaurant.name}\nАвтор: ${c.name}\nДата: ${c.created_at.split("T")[0]}\n\n` +
            c.text,
            c.profile_url || c.restaurant.review_url
                ? Markup.inlineKeyboard(
                    [
                        c.restaurant.review_url &&
                        Markup.button.url("Отзывы", c.restaurant.review_url),
                        c.profile_url &&
                        Markup.button.url("Профиль автора", c.profile_url),
                    ].filter(Boolean) as any[])
                : undefined
        );
        sentIds.push(msg.message_id);
    }

    // Навигация
    const totalCount = deptContainers.reduce((sum, c) => sum + (c.count || 0), 0);
    const pageCount = Math.ceil(totalCount / Number(f.page_size));
    const nav: any[] = [];
    if (page > 1)
        nav.push(Markup.button.callback("⬅️ Назад", `page:${page - 1}`));
    if (page < pageCount)
        nav.push(Markup.button.callback("Вперед ➡️", `page:${page + 1}`));
    if (nav.length) {
        const navMsg = await ctx.reply(
            `Страница ${page} из ${pageCount}`,
            Markup.inlineKeyboard([nav])
        );
        sentIds.push(navMsg.message_id);
    }

    userMessages.set(chatId, sentIds);
    f.lastChecked = new Date().toISOString();
    commentsFlowStep.delete(chatId);
}

// Команда /comments
bot.command("comments", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const f = getOrInitSettings(chatId);
    if (isFilledArray(f.department_ids)) {
        await ctx.reply(
            `Текущие фильтры:\nДепартаменты: ${f.department_ids.join(", ")}\nДаты: ${f.created_at_after ? "С" + f.created_at_after : ""
            } ${f.created_at_before ? "До" + f.created_at_before : ""}\nЗвезды: ${f.stars || "Все"
            }\nРесторан: ${f.restaurant_id || "Все"}\nPage size: ${f.page_size}`,
            mainKeyboard
        );
        commentsFlowStep.set(chatId, Step.GetData);
        return nextStep(ctx);
    }
    commentsFlowStep.set(chatId, Step.Preview);
    return nextStep(ctx);
});

// Команда /settings
bot.command("settings", async (ctx) => {
    const chatId = String(ctx.chat.id);
    commentsFlowStep.set(chatId, Step.Preview);
    return nextStep(ctx);
});

// Обработчики inline-кнопок
bot.action("cancel", async (ctx) => {
    const chatId = String(ctx?.chat?.id);
    commentsFlowStep.delete(chatId);
    await ctx.answerCbQuery();
    return ctx.reply("Операция отменена", mainKeyboard);
});

bot.action("skip", async (ctx) => {
    if (!isValidNumber(ctx?.chat?.id)) {
        return ctx.reply("Не удалось получить информацию о пользователе");
    }
    const chatId = String(ctx?.chat?.id);
    const step = commentsFlowStep.get(chatId);
    if (step === undefined) {
        return ctx.reply("Произошла ошибка, операция отменена", mainKeyboard);
    }
    commentsFlowStep.set(chatId, step + 1);
    await ctx.answerCbQuery();
    return nextStep(ctx);
});

bot.action(/dept_toggle:(.+)/, async (ctx) => {
    const chatId = String(ctx?.chat?.id);
    const deptId = ctx.match[1];
    const f = getOrInitSettings(chatId);
    const idx = f.department_ids.indexOf(deptId);
    if (idx === -1) {
        f.department_ids.push(deptId);
    } else {
        f.department_ids.splice(idx, 1);
    }

    await ctx.answerCbQuery();

    if (ctx.callbackQuery?.message?.message_id) {
        await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    }
    return nextStep(ctx);
});

bot.action("dept_done", async (ctx) => {
    const chatId = String(ctx?.chat?.id);
    const f = getOrInitSettings(chatId);
    const idx = f.department_ids;
    if (!isFilledArray(idx)) {
        return ctx.reply("Выберите хотя бы один департамент!");
    }
    await ctx.answerCbQuery();
    commentsFlowStep.set(chatId, Step.Dates);
    return nextStep(ctx);
});

bot.action(/rest:(\d+)/, async (ctx) => {
    if (!isValidNumber(ctx?.chat?.id)) {
        return ctx.reply("Не удалось получить информацию о пользователе");
    }
    const chatId = String(ctx?.chat?.id);
    const val = ctx.match[1];
    const f = getOrInitSettings(chatId);
    f.restaurant_id = val;
    await ctx.answerCbQuery();
    commentsFlowStep.set(chatId, Step.PageSize);
    return nextStep(ctx);
});

bot.start(async (ctx) => {
    await ctx.reply("Добро пожаловать!", mainKeyboard);
    await ctx.reply("Введите /comments чтобы увидеть отзывы", mainKeyboard);
});

bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const step = commentsFlowStep.get(chatId);
    if (step === undefined || step === Step.Department || step === Step.Preview)
        return;
    const f = getOrInitSettings(chatId);
    const text = ctx.message.text.trim();
    if (step === Step.Dates) {
        const m = text.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
        if (m) {
            f.created_at_after = m[1];
            f.created_at_before = m[2];
        } else {
            const m1 = text.match(/^(\d{4}-\d{2}-\d{2})$/);
            const m2 = text.match(/^:(\d{4}-\d{2}-\d{2})$/);
            if (m1) {
                f.created_at_after = m1[1];
            } else if (m2) {
                f.created_at_before = m2[1];
            } else {
                return ctx.reply("Неверный формат даты!");
            }
        }
    }
    if (step === Step.Stars) {
        const m = text.match(/^([1-5])(?:-([1-5]))?$/);
        if (!m) {
            return ctx.reply(
                "Неверный формат. Введите число от 1 до 5 в формате X-Y\n" +
                "где X и Y — числа от 1 до 5 и X < Y."
            );
        }

        const a = Number(m[1]);
        const b = m[2] !== undefined ? Number(m[2]) : null;

        if (b === null) {
            f.stars = [String(a)];
        } else if (a < b) {
            f.stars = [String(a), String(b)];
        } else {
            return ctx.reply(
                `Неверный диапазон: первое число (${a}) должно быть меньше второго (${b}).`
            );
        }
    }
    if (step === Step.PageSize) {
        if (/^[1-9]\d*$/.test(text)) {
            f.page_size = text;
        } else {
            return ctx.reply("Необходимо ввести выводимых количество отзывов!");
        }
    }
    commentsFlowStep.set(chatId, step + 1);
    return nextStep(ctx);
});

bot.action(/page:(\d+)/, async (ctx) => {
    const page = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    return fetchAndSend(ctx, page);
});

// Периодическое получение новых комментариев
setInterval(async () => {
    for (const [chatId, f] of userSettings.entries()) {
        try {
            const params: GetCommentsReq = {
                department_id: f.department_ids.join(","),
                page: "1",
                page_size: f.page_size,
                created_at_after: formatDateLocal(new Date(f.lastChecked)),
            };
            const cont = await fetchJSON<CommentContainer>(getCommentsUrl(params));
            for (const c of cont.results) {
                await bot.telegram.sendMessage(
                    chatId,
                    `${c.restaurant.type_comments_loader}\n${"★".repeat(
                        c.stars
                    )}\nРесторан: ${c.restaurant.name}\nАвтор: ${c.name}\nДата: ${c.created_at.split("T")[0]
                    }\n\n${c.text}`,
                    c.profile_url
                        ? Markup.inlineKeyboard([
                            Markup.button.url("Отзыв", c.restaurant.review_url),
                            Markup.button.url("Профиль автора", c.profile_url),
                        ])
                        : undefined
                );
            }
            f.lastChecked = new Date().toISOString();
        } catch (e) {
            console.error("Polling error for", chatId, e);
        }
    }
}, CHECK_INTERVAL);

// Запуск webhook и бота
(async () => {
    await initStorage();
    bot.launch();
    const app = express();
    app.use(express.json());
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
    app.post("/webhook", (req, res) => {
        bot
            .handleUpdate(req.body)
            .then(() => res.sendStatus(200))
            .catch((e) => {
                console.error(e);
                res.sendStatus(500);
            });
    });
    app.listen(PORT_NUM, () => console.log(`Listening on ${PORT_NUM}`));
})();
