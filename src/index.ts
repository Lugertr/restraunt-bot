import * as dotenv from "dotenv";
dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
import express from "express";
import { Telegraf, Markup } from "telegraf";
import { promises as fs } from "fs";
import path from "path";

// == Configuration ==
// BOT_TOKEN       — Telegram Bot API token
// WEBHOOK_URL     — Deploy url
// PORT            — Port
const { BOT_TOKEN, WEBHOOK_URL, PORT = "3000", API } = process.env;
if (!BOT_TOKEN) throw new Error("Environment variable BOT_TOKEN is required");
if (!WEBHOOK_URL)
    throw new Error("Environment variable WEBHOOK_URL is required");
if (!API) throw new Error("Environment variable API is required");
const API_BASE = API;
const STORAGE_PATH = path.resolve(process.cwd(), "subscriptions.json");
const PORT_NUM = Number(PORT);
const CHECK_INTERVAL = 60_0000;
const PAGE_SIZE = 5;

type Department = { id: string; name: string };
type CommentContainer = {
    count: number;
    next: string;
    previous: string;
    results: Comment[];
};
type Comment = {
    id: number;
    text: string;
    created_at: string;
    name: "string",
    profile_url: "string",
    stars: number;
    restaurant: number;
};
type Subscription = { departments: Set<string>; lastChecked: string };
type Storage = Map<string, Subscription>;

const storage: Storage = new Map();

async function loadStorage(): Promise<void> {
    try {
        const data = await fs.readFile(STORAGE_PATH, "utf8");
        const obj = JSON.parse(data) as Record<
            string,
            { departments: string[]; lastChecked: string }
        >;
        for (const [chatId, sub] of Object.entries(obj)) {
            storage.set(chatId, {
                departments: new Set(sub.departments),
                lastChecked: sub.lastChecked,
            });
        }
    } catch (err) {
        console.error("loadStorage error:", err);
    }
}

async function saveStorage(): Promise<void> {
    try {
        const obj: Record<string, { departments: string[]; lastChecked: string }> =
            {};
        storage.forEach((sub, chatId) => {
            obj[chatId] = {
                departments: Array.from(sub.departments),
                lastChecked: sub.lastChecked,
            };
        });
        await fs.writeFile(STORAGE_PATH, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error("saveStorage error:", err);
    }
}

async function fetchJSON<T>(url: string): Promise<T> {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return await res.json();
    } catch (err) {
        console.error(`fetchJSON error (${url}):`, err);
        throw err;
    }
}

const fetchDepartments = (): Promise<Department[]> =>
    fetchJSON(`${API_BASE}/departments/`);

const fetchComments = (
    dept: string,
    page = 1,
    after?: string
): Promise<CommentContainer> => {
    const params = new URLSearchParams({
        department_id: dept,
        page: String(page),
        page_size: String(PAGE_SIZE),
    });
    if (after) params.set("created_at_after", after);
    return fetchJSON(`${API_BASE}/comments/?${params}`);
};

const deptKeyboard = (depts: Department[]) =>
    Markup.inlineKeyboard(
        depts.map((d) => [Markup.button.callback(d.name, `dept:${d.id}`)])
    );

const unsubscribeKeyboard = (subs: string[]) =>
    Markup.inlineKeyboard(
        subs.map((id) => [Markup.button.callback(`Unsub ${id}`, `unsub:${id}`)])
    );

const paginationKeyboard = (dept: string, page: number, hasNext: boolean) =>
    Markup.inlineKeyboard([
        ...(page > 1
            ? [Markup.button.callback("⬅️ Prev", `page:${dept}:${page - 1}`)]
            : []),
        ...(hasNext
            ? [Markup.button.callback("Next ➡️", `page:${dept}:${page + 1}`)]
            : []),
    ]);

const bot = new Telegraf(BOT_TOKEN!);

bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    ctx.reply("Произошла непредвиденная ошибка. Пожалуйста, попробуйте позже.");
});

bot.start(async (ctx) => {
    try {
        const depts = await fetchDepartments();
        await ctx.reply("Пожалуйста, выберите подразделение:", deptKeyboard(depts));
    } catch (err) {
        console.error("Bot error:", err);
        await ctx.reply(
            "Не удалось загрузить список подразделений. Попробуйте позже."
        );
    }
});

bot.command("unsubscribe", async (ctx) => {
    try {
        const chatId = String(ctx.chat!.id);
        const sub = storage.get(chatId);
        if (!sub || sub.departments.size === 0)
            return ctx.reply("У вас нет активных подписок.");
        await ctx.reply(
            "Отписаться от подразделения:",
            unsubscribeKeyboard([...sub.departments])
        );
    } catch (err) {
        console.error("Bot error:", err);
        await ctx.reply("Ошибка при обработке команды отписки.");
    }
});

bot.action(/(dept|unsub|page):([^:\s]+)(?::(\d+))?/, async (ctx) => {
    try {
        const [, action, payload, pageStr] = ctx.match!;
        const chatId = String(ctx.chat!.id);
        let sub = storage.get(chatId);
        if (!sub) {
            sub = { departments: new Set(), lastChecked: new Date(0).toISOString() };
            storage.set(chatId, sub);
        }
        await ctx.answerCbQuery();
        if (action === "dept") {
            sub.departments.add(payload);
            await saveStorage();
            await ctx.reply(`Вы подписались на подразделение ${payload}`);
            await sendComments(ctx, payload, 1);
            sub.lastChecked = new Date().toISOString();
            await saveStorage();
        } else if (action === "unsub") {
            sub.departments.delete(payload);
            await saveStorage();
            await ctx.reply(`Вы отписались от подразделения ${payload}`);
        } else if (action === "page") {
            const page = Number(pageStr);
            await sendComments(ctx, payload, page);
        }
    } catch (err) {
        console.error("Bot error:", err);
        await ctx.reply("Ошибка при выполнении действия. Попробуйте позже.");
    }
});

const sendCommentCommand = async (c: Comment, chatId: number) => {
    if (!c) {
        return;
    }
    await bot.telegram.sendMessage(
        chatId,
        `${'★'.repeat(c.stars)}\n${c.restaurant}\nавтор: ${c.name}\n\n${c.text}`,
        c.profile_url ? Markup.inlineKeyboard([
            Markup.button.url('Открыть профиль автора', c.profile_url),
        ]) : undefined
    );
}

async function sendComments(ctx: any, dept: string, page: number) {
    try {
        const commentsContainer = await fetchComments(dept, page);
        const comments = commentsContainer?.results || null;
        if (comments?.length === 0) return ctx.reply("Отзывы не найдены.");
        for (const c of comments) await sendCommentCommand(c, ctx.from.id);
        await ctx.reply(
            `Страница ${page} из ${commentsContainer.count}`,
            paginationKeyboard(dept, page, comments.length === PAGE_SIZE)
        );
    } catch (err) {
        console.error("Bot error:", err);
        await ctx.reply("Не удалось получить отзывы. Попробуйте позже.");
    }
}

setInterval(async () => {
    for (const [chatId, sub] of storage) {
        for (const dept of sub.departments) {
            try {
                const commentsContainer = await fetchComments(dept, 1, sub.lastChecked);
                const comments = commentsContainer?.results || null;

                for (const c of comments) {
                    const numChatId = Number(chatId);
                    if (numChatId && !isNaN(numChatId)) {
                        sendCommentCommand(c, numChatId);
                    }
                }
                const currentDate = new Date();
                const isoString = currentDate.toISOString();
                sub.lastChecked = isoString;
                await saveStorage();
            } catch (err) {
                console.error("Polling error:", err);
            }
        }
    }
}, CHECK_INTERVAL);

const app = express();
app.use(express.json());
app.post("/webhook", (req, res) => {
    try {
        return bot.handleUpdate(req.body, res);
    } catch (err) {
        console.error("Webhook error:", err);
        return res.sendStatus(500);
    }
});

(async () => {
    try {
        await loadStorage();
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
        app.listen(PORT_NUM, () =>
            console.log(`Server listening on port ${PORT_NUM}`)
        );
    } catch (err) {
        console.error("Startup error:", err);
        process.exit(1);
    }
})();
