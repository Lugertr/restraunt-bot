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
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
// == Configuration ==
// BOT_TOKEN       — Telegram Bot API token
// WEBHOOK_URL     — Public HTTPS URL where Telegram will POST updates (e.g. https://example.com)
// PORT            — Port for Express server (default 3000)
const { BOT_TOKEN, WEBHOOK_URL, PORT = "3000" } = process.env;
if (!BOT_TOKEN)
    throw new Error("Environment variable BOT_TOKEN is required");
if (!WEBHOOK_URL)
    throw new Error("Environment variable WEBHOOK_URL is required");
const API_BASE = "https://your.api.server/api/api";
const STORAGE_PATH = path_1.default.resolve(process.cwd(), "subscriptions.json");
const PORT_NUM = Number(PORT);
const CHECK_INTERVAL = 60_000; // Poll interval
const PAGE_SIZE = 5; // Comments per page
// == In-memory storage ==
const storage = new Map();
// == Persistence ==
async function loadStorage() {
    try {
        const data = await fs_1.promises.readFile(STORAGE_PATH, "utf8");
        const obj = JSON.parse(data);
        for (const [chatId, sub] of Object.entries(obj)) {
            storage.set(chatId, {
                departments: new Set(sub.departments),
                lastChecked: sub.lastChecked,
            });
        }
    }
    catch (err) {
        console.error("loadStorage error:", err);
    }
}
async function saveStorage() {
    try {
        const obj = {};
        storage.forEach((sub, chatId) => {
            obj[chatId] = {
                departments: Array.from(sub.departments),
                lastChecked: sub.lastChecked,
            };
        });
        await fs_1.promises.writeFile(STORAGE_PATH, JSON.stringify(obj, null, 2));
    }
    catch (err) {
        console.error("saveStorage error:", err);
    }
}
// == HTTP helper ==
async function fetchJSON(url) {
    try {
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return await res.json();
    }
    catch (err) {
        console.error(`fetchJSON error (${url}):`, err);
        throw err;
    }
}
// == API Fetchers ==
const fetchDepartments = () => fetchJSON(`${API_BASE}/departments/`);
const fetchComments = (dept, page = 1, after) => {
    const params = new URLSearchParams({
        department_id: dept,
        page: String(page),
        page_size: String(PAGE_SIZE),
    });
    if (after)
        params.set("created_at_after", after);
    return fetchJSON(`${API_BASE}/comments/?${params}`);
};
// == Keyboards ==
const deptKeyboard = (depts) => telegraf_1.Markup.inlineKeyboard(depts.map((d) => [telegraf_1.Markup.button.callback(d.name, `dept:${d.id}`)]));
const unsubscribeKeyboard = (subs) => telegraf_1.Markup.inlineKeyboard(subs.map((id) => [telegraf_1.Markup.button.callback(`Unsub ${id}`, `unsub:${id}`)]));
const paginationKeyboard = (dept, page, hasNext) => telegraf_1.Markup.inlineKeyboard([
    ...(page > 1
        ? [telegraf_1.Markup.button.callback("⬅️ Prev", `page:${dept}:${page - 1}`)]
        : []),
    ...(hasNext
        ? [telegraf_1.Markup.button.callback("Next ➡️", `page:${dept}:${page + 1}`)]
        : []),
]);
// == Bot Setup ==
const bot = new telegraf_1.Telegraf(BOT_TOKEN);
bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    ctx.reply("An unexpected error occurred.");
});
bot.start(async (ctx) => {
    try {
        const depts = await fetchDepartments();
        await ctx.reply("Select department:", deptKeyboard(depts));
    }
    catch {
        await ctx.reply("Unable to load departments.");
    }
});
bot.command("unsubscribe", async (ctx) => {
    try {
        const chatId = String(ctx.chat.id);
        const sub = storage.get(chatId);
        if (!sub || sub.departments.size === 0)
            return ctx.reply("No active subscriptions.");
        await ctx.reply("Unsubscribe from:", unsubscribeKeyboard([...sub.departments]));
    }
    catch {
        await ctx.reply("Error processing unsubscribe.");
    }
});
bot.action(/(dept|unsub|page):(.+?)(?::(\d+))?/, async (ctx) => {
    try {
        const [, action, payload, pageStr] = ctx.match;
        const chatId = String(ctx.chat.id);
        let sub = storage.get(chatId);
        if (!sub) {
            sub = { departments: new Set(), lastChecked: new Date(0).toISOString() };
            storage.set(chatId, sub);
        }
        await ctx.answerCbQuery();
        if (action === "dept") {
            sub.departments.add(payload);
            await saveStorage();
            await ctx.reply(`Subscribed to ${payload}`);
            await sendComments(ctx, payload, 1);
            sub.lastChecked = new Date().toISOString();
            await saveStorage();
        }
        else if (action === "unsub") {
            sub.departments.delete(payload);
            await saveStorage();
            await ctx.reply(`Unsubscribed from ${payload}`);
        }
        else if (action === "page") {
            const page = Number(pageStr);
            await sendComments(ctx, payload, page);
        }
    }
    catch {
        await ctx.reply("Error handling action.");
    }
});
// == Helper: send paginated comments ==
async function sendComments(ctx, dept, page) {
    try {
        const comments = await fetchComments(dept, page);
        if (comments.length === 0)
            return ctx.reply("No comments found.");
        for (const c of comments)
            await ctx.reply(`[${c.department_id}] ${c.text}`);
        await ctx.reply("Navigate:", paginationKeyboard(dept, page, comments.length === PAGE_SIZE));
    }
    catch {
        await ctx.reply("Error fetching comments.");
    }
}
// == Periodic Polling ==
setInterval(async () => {
    for (const [chatId, sub] of storage) {
        for (const dept of sub.departments) {
            try {
                const comments = await fetchComments(dept, 1, sub.lastChecked);
                for (const c of comments) {
                    await bot.telegram.sendMessage(chatId, `🆕 [${c.department_id}] ${c.text}`);
                }
                if (comments.length > 0) {
                    sub.lastChecked = comments[0].created_at;
                    await saveStorage();
                }
            }
            catch (err) {
                console.error("Polling error:", err);
            }
        }
    }
}, CHECK_INTERVAL);
// == Express Webhook Server ==
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.post("/webhook", (req, res) => {
    try {
        return bot.handleUpdate(req.body, res);
    }
    catch (err) {
        console.error("Webhook error:", err);
        return res.sendStatus(500);
    }
});
(async () => {
    try {
        await loadStorage();
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
        app.listen(PORT_NUM, () => console.log(`Server listening on port ${PORT_NUM}`));
    }
    catch (err) {
        console.error("Startup error:", err);
        process.exit(1);
    }
})();
