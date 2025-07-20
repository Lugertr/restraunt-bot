import * as dotenv from "dotenv";
dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
import express from "express";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { formatDateLocal, isFilledArray, isValidNumber } from "./ts/helpers";
import {
    Department,
    Restaurant,
    Filters,
    Step,
    CommentContainer,
} from "./ts/types";
import {
    ensureFiltersFile,
    readJsonFile,
    writeJsonFile,
    ensureCache,
    sendInlineKeyboard,
    sendSkipCancel,
    clearPrevious,
} from "./ts/utils";

// Константы и конфигурация
const { BOT_TOKEN, WEBHOOK_URL, PORT = "3000", API } = process.env;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!WEBHOOK_URL) throw new Error("WEBHOOK_URL is required");
if (!API) throw new Error("API is required");
const API_BASE = API;
const STORAGE_PATH = path.resolve(process.cwd(), "filters.json");
const PORT_NUM = Number(PORT);
const CHECK_INTERVAL = 3_600_000;
const DEFAULT_PAGE_SIZE = 5;

const bot = new Telegraf(BOT_TOKEN);
const sessionCache = new Map<
    string,
    { depts?: Department[]; restaurants?: Restaurant[] }
>();
const userFilters = new Map<string, Filters>();
const commentsFlowStep = new Map<string, Step>();
const userPage = new Map<string, number>();
const userMessages = new Map<string, number[]>();

// Создать файл filters.json, если отсутствует, и загрузить его содержимое
async function initStorage() {
    await ensureFiltersFile(STORAGE_PATH);
    const data = await readJsonFile<Record<string, Filters>>(STORAGE_PATH);
    Object.entries(data).forEach(([chatId, f]) => userFilters.set(chatId, f));
}
// Сохранить userFilters в файл
async function persistFilters() {
    const obj: Record<string, Filters> = {};
    userFilters.forEach((f, chatId) => (obj[chatId] = f));
    await writeJsonFile(STORAGE_PATH, obj);
}

// Получить или инициализировать фильтры для chatId
function getOrInitFilters(chatId: string): Filters {
    let f = userFilters.get(chatId);
    if (!f) {
        f = {
            department_ids: [],
            page_size: String(DEFAULT_PAGE_SIZE),
            lastChecked: new Date(0).toISOString(),
        };
        userFilters.set(chatId, f);
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
function buildCommentQuery(params: Record<string, string>) {
    return `${API_BASE}/comments/?${new URLSearchParams(params)}`;
}

// Основные клавиатуры
const mainKeyboard = Markup.keyboard([
    ["/comments — Показать отзывы"],
    ["/filters — Показать или изменить фильтры"],
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
                const f = getOrInitFilters(chatId);
                if (isFilledArray(f.department_ids)) {
                    await ctx.reply(
                        `Текущие фильтры:\nДепартаменты: ${f.department_ids.join(
                            ", "
                        )}\nДаты: ${f.created_at_after ? "С" + f.created_at_after : ""}:${f.created_at_before ? "До" + f.created_at_before : ""
                        }\nЗвезды: ${f.stars || "Все"}\nРесторан: ${f.restaurant_id || "Все"
                        }\nPage size: ${f.page_size}`,
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
                return sendInlineKeyboard(
                    ctx,
                    "Шаг 1: Выберите департамент:",
                    depts
                        .map((d) => Markup.button.callback(d.name, `dept:${d.id}`))
                        .concat(cancelBtn)
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
                    "Шаг 4: Введите количество выводимых отзывов на страницу",
                    skipBtn,
                    cancelBtn
                );
            default:
                await ctx.reply("Пожалуйста, подождите, получаем отзывы...");
                return fetchAndSend(ctx, 1);
        }
    } catch (e) {
        console.error("nextStep error:", e);
        await ctx.reply("Ошибка шага ввода фильтра. Начните заново.");
        commentsFlowStep.delete(chatId);
    }
}

// Получение и вывод комментариев с поддержкой пагинации
async function fetchAndSend(ctx: any, page: number) {
    const chatId = String(ctx.chat.id);
    try {
        await clearPrevious(ctx, userMessages, chatId);
        userPage.set(chatId, page);
        const f = getOrInitFilters(chatId);
        const params: Record<string, string> = {
            department_id: f.department_ids[0],
            page: String(page),
            page_size: f.page_size,
        };
        if (f.created_at_after) params.created_at_after = f.created_at_after;
        if (f.created_at_before) params.created_at_before = f.created_at_before;
        if (f.stars) params.stars = f.stars;
        if (f.restaurant_id) params.restaurant = f.restaurant_id;
        const cont = await fetchJSON<CommentContainer>(buildCommentQuery(params));
        const ids: number[] = [];
        if (!isFilledArray(cont?.results)) {
            return ctx.reply("Отзывы отсутствуют");
        }
        for (const c of cont.results) {
            const msg = await bot.telegram.sendMessage(
                chatId,
                `${c.restaurant.type_comments_loader}\n${"★".repeat(
                    c.stars
                )}\nРесторан: ${c.restaurant.name}\nАвтор: ${c.name}\nДата: ${c.created_at.split("T")[0]
                }\n\n${c.text}`,
                c.profile_url && c.restaurant.review_url
                    ? Markup.inlineKeyboard([
                        Markup.button.url("Отзыв", c.restaurant.review_url),
                        Markup.button.url("Профиль автора", c.profile_url),
                    ])
                    : c.profile_url
                        ? Markup.inlineKeyboard([
                            Markup.button.url("Профиль автора", c.profile_url),
                        ])
                        : c.restaurant.review_url
                            ? Markup.inlineKeyboard([
                                Markup.button.url("Отзыв", c.restaurant.review_url),
                            ])
                            : undefined
            );
            ids.push(msg.message_id);
        }
        const nav: any[] = [];
        if (page > 1)
            nav.push(Markup.button.callback("⬅️ Назад", `page:${page - 1}`));
        if (cont.next)
            nav.push(Markup.button.callback("Вперед ➡️", `page:${page + 1}`));
        if (nav.length) {
            const m = await ctx.reply(
                `Страница ${page} из ${Math.ceil(cont.count / Number(f.page_size))}`,
                Markup.inlineKeyboard([nav])
            );
            ids.push(m.message_id);
        }
        userMessages.set(chatId, ids);
        f.lastChecked = new Date().toISOString();
        commentsFlowStep.delete(chatId);
        await persistFilters();
    } catch (e) {
        console.error("fetchAndSend error:", e);
        await ctx.reply("Не удалось получить отзывы. Попробуйте позже.");
    }
}

// Команда /comments
bot.command("comments", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const f = getOrInitFilters(chatId);
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

// Команда /filters
bot.command("filters", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const f = getOrInitFilters(chatId);
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

bot.action(/dept:(.+)/, async (ctx) => {
    if (!isValidNumber(ctx?.chat?.id)) {
        return ctx.reply("Не удалось получить информацию о пользователе");
    }
    const chatId = String(ctx?.chat?.id);
    const val = ctx.match[1];
    const f = getOrInitFilters(chatId);
    f.department_ids = [val];
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
    const f = getOrInitFilters(chatId);
    f.restaurant_id = val;
    await ctx.answerCbQuery();
    commentsFlowStep.set(chatId, Step.PageSize);
    return nextStep(ctx);
});

bot.start(async ctx => {
    await ctx.reply('Добро пожаловать!', mainKeyboard);
    await ctx.reply('Введите /comments чтобы увидеть отзывы', mainKeyboard);
});

bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const step = commentsFlowStep.get(chatId);
    if (step === undefined || step === Step.Department || step === Step.Preview)
        return;
    const f = getOrInitFilters(chatId);
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
        const m = text.match(/^(\d)(?:-(\d))?$/);
        if (m) {
            f.stars = m[1];
        } else {
            return ctx.reply("Необходимо ввести число от 1 до 5!");
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
    for (const [chatId, f] of userFilters.entries()) {
        try {
            const params: Record<string, string> = {
                department_id: f.department_ids.join(","),
                page: "1",
                page_size: f.page_size,
                created_at_after: formatDateLocal(new Date(f.lastChecked)),
            };
            const cont = await fetchJSON<CommentContainer>(buildCommentQuery(params));
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
    await persistFilters();
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
