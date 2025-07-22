"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
const express_1 = __importDefault(require("express"));
const telegraf_1 = require("telegraf");
const path_1 = __importDefault(require("path"));
const helpers_1 = require("./ts/helpers");
const utils_1 = require("./ts/utils");
const { BOT_TOKEN, WEBHOOK_URL, PORT = "3000", API } = process.env;
if (!BOT_TOKEN)
    throw new Error("BOT_TOKEN is required");
if (!WEBHOOK_URL)
    throw new Error("WEBHOOK_URL is required");
if (!API)
    throw new Error("API is required");
const API_BASE = API;
const STORAGE_PATH = path_1.default.resolve(process.cwd(), "settings.json");
const PORT_NUM = Number(PORT);
const CHECK_INTERVAL = 3_600_000;
const DEFAULT_PAGE_SIZE = 5;
const bot = new telegraf_1.Telegraf(BOT_TOKEN);
const sessionCache = new Map();
const userSettings = new Map();
const commentsFlowStep = new Map();
const userPage = new Map();
const userMessages = new Map();
const commentsCache = new Map();
async function initStorage() {
    await (0, utils_1.ensureSettingsFile)(STORAGE_PATH);
    const data = await (0, utils_1.readJsonFile)(STORAGE_PATH);
    Object.entries(data).forEach(([chatId, f]) => userSettings.set(chatId, f));
}
// Сохранить userSettings в файл
async function persistSettings() {
    const obj = {};
    userSettings.forEach((f, chatId) => (obj[chatId] = f));
    await (0, utils_1.writeJsonFile)(STORAGE_PATH, obj);
}
// Получить или инициализировать фильтры для chatId
function getOrInitSettings(chatId) {
    let f = userSettings.get(chatId);
    if (!f) {
        f = {
            department_ids: [],
            page_size: String(DEFAULT_PAGE_SIZE),
            lastChecked: new Date(0).toISOString(),
            subscribed: false,
        };
        userSettings.set(chatId, f);
    }
    return f;
}
async function fetchJSON(url) {
    try {
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`HTTP ${res.status} ${url}`);
        return res.json();
    }
    catch (error) {
        console.error(`Failed to fetch ${url}`, error);
        return null;
    }
}
const fetchDepartments = () => fetchJSON(`${API_BASE}/departments/`);
const fetchRestaurants = () => fetchJSON(`${API_BASE}/restaurants/`);
function getCommentsUrl(params) {
    //TO DO FIX TYPES
    return `${API_BASE}/comments/?${params}`;
}
function formatSettingsSummary(s) {
    return [
        `Департаменты: ${s.department_ids.join(", ") || "Все"}`,
        `Даты: ${s.created_at_after ? "С" + s.created_at_after : ""}${s.created_at_before ? " До" + s.created_at_before : ""}`.trim(),
        `Звезды: ${s.stars?.join("-") || "Все"}`,
        `Ресторан: ${s.restaurant_id || "Все"}`,
        `Количество отзывов на отдельный департамент: ${s.page_size}`,
    ].join("\n");
}
// Основные клавиатуры
const mainKeyboard = telegraf_1.Markup.keyboard([
    ["/comments — Показать отзывы"],
    ["/settings — Показать или изменить настройки"],
]).resize();
const cancelBtn = telegraf_1.Markup.button.callback("❌ Отмена", "cancel");
const skipBtn = telegraf_1.Markup.button.callback("⏭️ Пропустить", "skip");
// Обработчик ошибок бота
bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    ctx.reply("Произошла неожиданная ошибка");
});
// Пошаговая логика ввода фильтров
async function nextStep(ctx) {
    const chatId = String(ctx.chat.id);
    const step = commentsFlowStep.get(chatId) ?? 0 /* Step.Preview */;
    try {
        switch (step) {
            case 0 /* Step.Preview */: {
                const s = getOrInitSettings(chatId);
                let subscribeBtn = s.subscribed
                    ? telegraf_1.Markup.button.callback("Отписаться от новых отзывов", "toggle_subscribe")
                    : telegraf_1.Markup.button.callback("Подписаться на новые отзывы", "toggle_subscribe");
                if ((0, helpers_1.isFilledArray)(s.department_ids)) {
                    await ctx.reply(`Текущие настройки:\n${formatSettingsSummary(s)}`, mainKeyboard);
                    return (0, utils_1.sendInlineKeyboard)(ctx, "Изменить настройки?", [
                        telegraf_1.Markup.button.callback("Да", "skip"),
                        subscribeBtn,
                        telegraf_1.Markup.button.callback("❌ Отмена", "cancel"),
                    ]);
                }
                else {
                    return (0, utils_1.sendInlineKeyboard)(ctx, "Настройте нужные параметры для просмотра отзывов", [
                        telegraf_1.Markup.button.callback("Начать настройку", "skip"),
                        telegraf_1.Markup.button.callback("❌ Отмена", "cancel"),
                    ]);
                }
            }
            case 1 /* Step.Department */: {
                const depts = (await (0, utils_1.ensureCache)(sessionCache, chatId, "depts", fetchDepartments)) || [];
                const s = getOrInitSettings(chatId);
                s.isValChanges = false;
                const buttons = depts.map((d) => {
                    const isSel = s.department_ids.includes(String(d.id));
                    const text = `${isSel ? "✅ " : ""}${d.name}`;
                    return telegraf_1.Markup.button.callback(text, `dept_toggle:${d.id}`);
                });
                buttons.push(telegraf_1.Markup.button.callback("✔️ Готово", "dept_done"), cancelBtn);
                return (0, utils_1.sendInlineKeyboard)(ctx, "Шаг 1: Выберите департамент(ы):", buttons);
            }
            case 2 /* Step.Dates */:
                return (0, utils_1.sendSkipCancel)(ctx, "Шаг 2: Пропустите шаг или введите даты в формате:\n\nYYYY-MM-DD:YYYY-MM-DD для диапазона\n\nYYYY-MM-DD — только дата начала\n\n:YYYY-MM-DD — только дата конца.", skipBtn, cancelBtn);
            case 3 /* Step.Stars */:
                return (0, utils_1.sendSkipCancel)(ctx, "Шаг 3: Пропустите шаг или введите количество звезд, поставленных пользователем, одним числом или двумя, например 1-4 (звезды могут быть от 1 до 5)", skipBtn, cancelBtn);
            case 4 /* Step.PageSize */:
                return (0, utils_1.sendSkipCancel)(ctx, "Шаг 4: Введите количество выводимых отзывов по отдельному департаменту на страницу (по умолчанию 5)", skipBtn, cancelBtn);
            case 5 /* Step.Subscription */:
                const s = getOrInitSettings(chatId);
                if (!s.isValChanges) {
                    return (0, utils_1.sendInlineKeyboard)(ctx, "Хотите подписаться на новые отзывы?", [
                        telegraf_1.Markup.button.callback("Да, подписаться", "subscribe_save"),
                        telegraf_1.Markup.button.callback("Нет", "nosub"),
                    ]);
                }
            default:
                const set = getOrInitSettings(chatId);
                delete set.isValChanges;
                await ctx.reply("Пожалуйста, подождите, получаем отзывы...");
                await persistSettings();
                return fetchAndSend(ctx, 1);
        }
    }
    catch (e) {
        console.error("nextStep error:", e);
        await ctx.reply("Ошибка шага ввода фильтра. Начните заново.");
        commentsFlowStep.delete(chatId);
    }
}
async function fetchAndSend(ctx, page, isIntervalReq) {
    const chatId = String(ctx.chat.id);
    const s = getOrInitSettings(chatId);
    let cacheContainer = commentsCache.get(chatId);
    if (!cacheContainer) {
        cacheContainer = {};
        commentsCache.set(chatId, cacheContainer);
    }
    const containers = (await Promise.all(s.department_ids.map(async (deptId) => {
        const dateData = {
            ...(!isIntervalReq
                ? s.created_at_before && {
                    created_at_before: s.created_at_before,
                    ...(s.created_at_after && {
                        created_at_after: s.created_at_after,
                    }),
                }
                : {
                    created_at_after: (0, helpers_1.formatDateLocal)(new Date(s.lastChecked)),
                }),
        };
        const params = {
            department_id: deptId,
            page: String(page),
            page_size: s.page_size,
            ...dateData,
            ...(s.stars && { stars: s.stars.join(",") }),
            ...(s.restaurant_id && { restaurant: s.restaurant_id }),
        };
        const urlParams = `${new URLSearchParams(params)}`;
        const existingData = cacheContainer[urlParams];
        if (existingData) {
            return existingData;
        }
        const result = await fetchJSON(getCommentsUrl(urlParams));
        if (result) {
            cacheContainer[urlParams] = result;
        }
        return result;
    }))).filter(Boolean);
    const results = containers.flatMap((c) => c.results || []);
    if (!(0, helpers_1.isFilledArray)(results))
        return ctx.reply("Нет отзывов");
    await (0, utils_1.clearPrevious)(ctx, userMessages, chatId);
    userPage.set(chatId, page);
    const sent = [];
    for (const c of results) {
        const msg = await bot.telegram.sendMessage(chatId, `${c.restaurant.type_comments_loader}\n${"★".repeat(c.stars)}\n` +
            `Ресторан: ${c.restaurant.name}\nАвтор: ${c.name}\nДата: ${c.created_at.split("T")[0]}\n\n` +
            c.text, c.profile_url
            ? telegraf_1.Markup.inlineKeyboard([
                telegraf_1.Markup.button.url("Отзывы", c.restaurant.review_url),
                telegraf_1.Markup.button.url("Профиль", c.profile_url),
            ])
            : undefined);
        sent.push(msg.message_id);
    }
    const pages = Math.max(...containers.map((c) => Math.ceil(c.count / Number(s.page_size))));
    const nav = [];
    console.log(pages);
    console.log(containers);
    if (page > 1)
        nav.push(telegraf_1.Markup.button.callback("⬅️", `page:${page - 1}`));
    if (page < pages)
        nav.push(telegraf_1.Markup.button.callback("➡️", `page:${page + 1}`));
    if (nav.length) {
        const navMsg = await ctx.reply(`Страница ${page}/${pages}`, telegraf_1.Markup.inlineKeyboard([nav]));
        sent.push(navMsg.message_id);
    }
    userMessages.set(chatId, sent);
    s.lastChecked = new Date().toISOString();
    commentsFlowStep.delete(chatId);
    persistSettings();
}
// Команда /comments
bot.command("comments", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const s = getOrInitSettings(chatId);
    if ((0, helpers_1.isFilledArray)(s.department_ids)) {
        await ctx.reply(`Текущие фильтры:\n${formatSettingsSummary(s)}`, mainKeyboard);
        commentsFlowStep.set(chatId, 6 /* Step.GetData */);
        return nextStep(ctx);
    }
    commentsFlowStep.set(chatId, 0 /* Step.Preview */);
    return nextStep(ctx);
});
// Команда /settings
bot.command("settings", async (ctx) => {
    const chatId = String(ctx.chat.id);
    commentsFlowStep.set(chatId, 0 /* Step.Preview */);
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
    if (!(0, helpers_1.isValidNumber)(ctx?.chat?.id)) {
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
    const s = getOrInitSettings(chatId);
    const idx = s.department_ids.indexOf(deptId);
    if (idx === -1) {
        s.department_ids.push(deptId);
    }
    else {
        s.department_ids.splice(idx, 1);
    }
    await ctx.answerCbQuery();
    if (ctx.callbackQuery?.message?.message_id) {
        await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    }
    s.isValChanges = true;
    return nextStep(ctx);
});
bot.action("dept_done", async (ctx) => {
    const chatId = String(ctx?.chat?.id);
    const s = getOrInitSettings(chatId);
    const idx = s.department_ids;
    if (!(0, helpers_1.isFilledArray)(idx)) {
        return ctx.reply("Выберите хотя бы один департамент!");
    }
    await ctx.answerCbQuery();
    commentsFlowStep.set(chatId, 2 /* Step.Dates */);
    return nextStep(ctx);
});
bot.action("toggle_subscribe", async (ctx) => {
    const chatId = String(ctx.chat?.id);
    const s = getOrInitSettings(chatId);
    s.subscribed = !s.subscribed;
    await persistSettings();
    await ctx.answerCbQuery(s.subscribed ? "Подписка включена" : "Подписка выключена");
    return ctx.reply(s.subscribed ? "Вы подписаны!" : "Вы отписаны.", mainKeyboard);
});
bot.action("subscribe_save", async (ctx) => {
    const chatId = String(ctx.chat?.id);
    const s = getOrInitSettings(chatId);
    s.subscribed = true;
    await ctx.answerCbQuery("Подписка сохранена");
    await ctx.reply("Готово! Настройки и подписка сохранены.", mainKeyboard);
    const step = commentsFlowStep.get(chatId);
    commentsFlowStep.set(chatId, step + 1);
    return nextStep(ctx);
});
bot.action("nosub", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Настройки сохранены без подписки.", mainKeyboard);
    return persistSettings();
});
bot.start(async (ctx) => {
    await ctx.reply("Добро пожаловать!", mainKeyboard);
    await ctx.reply("Введите /comments чтобы увидеть отзывы", mainKeyboard);
});
bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const step = commentsFlowStep.get(chatId);
    if (step === undefined || step === 1 /* Step.Department */ || step === 0 /* Step.Preview */)
        return;
    const s = getOrInitSettings(chatId);
    const text = ctx.message.text.trim();
    if (step === 2 /* Step.Dates */) {
        const m = text.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
        if (m) {
            s.created_at_after = m[1];
            s.created_at_before = m[2];
        }
        else {
            const m1 = text.match(/^(\d{4}-\d{2}-\d{2})$/);
            const m2 = text.match(/^:(\d{4}-\d{2}-\d{2})$/);
            if (m1) {
                s.created_at_after = m1[1];
            }
            else if (m2) {
                s.created_at_before = m2[1];
            }
            else {
                return ctx.reply("Неверный формат даты!");
            }
        }
    }
    if (step === 3 /* Step.Stars */) {
        const m = text.match(/^([1-5])(?:-([1-5]))?$/);
        if (!m) {
            return ctx.reply("Неверный формат. Введите число от 1 до 5 в формате X-Y\n" +
                "где X и Y — числа от 1 до 5 и X < Y.");
        }
        const a = Number(m[1]);
        const b = m[2] !== undefined ? Number(m[2]) : null;
        if (b === null) {
            s.stars = [String(a)];
        }
        else if (a < b) {
            s.stars = [String(a), String(b)];
        }
        else {
            return ctx.reply(`Неверный диапазон: первое число (${a}) должно быть меньше второго (${b}).`);
        }
    }
    if (step === 4 /* Step.PageSize */) {
        if (/^[1-9]\d*$/.test(text)) {
            s.page_size = text;
        }
        else {
            return ctx.reply("Необходимо ввести выводимых количество отзывов!");
        }
    }
    commentsFlowStep.set(chatId, step + 1);
    s.isValChanges = true;
    return nextStep(ctx);
});
bot.action(/page:(\d+)/, async (ctx) => {
    const page = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    return fetchAndSend(ctx, page);
});
setInterval(async () => {
    for (const [chatId, s] of userSettings.entries()) {
        if (!s.subscribed)
            continue;
        try {
            await fetchAndSend({
                chat: { id: chatId },
                reply: () => { },
                answerCbQuery: () => { },
            }, 1);
        }
        catch { }
    }
}, CHECK_INTERVAL);
// Запуск webhook и бота
(async () => {
    await initStorage();
    bot.launch();
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
    app.post("/webhook", (req, res) => bot
        .handleUpdate(req.body)
        .then(() => res.sendStatus(200))
        .catch(() => res.sendStatus(500)));
    app.listen(PORT_NUM, () => console.log(`Listening ${PORT_NUM}`));
})();
