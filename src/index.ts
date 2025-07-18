import * as dotenv from "dotenv";
dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
import express from "express";
import { Telegraf, Markup } from "telegraf";
import { promises as fs } from "fs";
import path from "path";

// == Configuration ==
const { BOT_TOKEN, WEBHOOK_URL, PORT = "3000", API } = process.env;
if (!BOT_TOKEN) throw new Error("Environment variable BOT_TOKEN is required");
if (!WEBHOOK_URL) throw new Error("Environment variable WEBHOOK_URL is required");
if (!API) throw new Error("Environment variable API is required");
const API_BASE = API;
const STORAGE_PATH = path.resolve(process.cwd(), "subscriptions.json");
const PORT_NUM = Number(PORT);
const CHECK_INTERVAL = 60_0000;
const DEFAULT_PAGE_SIZE = 5;

// == Filters State ==
type Filters = {
    department_ids: string[];
    restaurant_id?: string;
    created_at_after?: string;
    created_at_before?: string;
    stars?: string;
    page_size?: string;
};
const userFilters = new Map<string, Filters>();
const userAwaiting = new Map<string, string>();

// == Types ==
type Department = { id: string; name: string };
type Restaurant = { id: number; name: string };
type Comment = { id: number; text: string; created_at: string; name: string; profile_url: string; stars: number; restaurant: number };
type CommentContainer = { count: number; next: string; previous: string; results: Comment[] };
type Subscription = { departments: Set<string>; lastChecked: string };
type Storage = Map<string, Subscription>;

// == Storage ==
const storage: Storage = new Map();
async function loadStorage(): Promise<void> {
    try {
        const data = await fs.readFile(STORAGE_PATH, "utf8");
        const obj = JSON.parse(data) as Record<string, { departments: string[]; lastChecked: string }>;
        for (const [chatId, sub] of Object.entries(obj)) {
            storage.set(chatId, { departments: new Set(sub.departments), lastChecked: sub.lastChecked });
        }
    } catch { }
}
async function saveStorage(): Promise<void> {
    const obj: Record<string, { departments: string[]; lastChecked: string }> = {};
    storage.forEach((sub, chatId) => {
        obj[chatId] = { departments: Array.from(sub.departments), lastChecked: sub.lastChecked };
    });
    await fs.writeFile(STORAGE_PATH, JSON.stringify(obj, null, 2));
}

// == API ==
async function fetchJSON<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
}
const fetchDepartments = (): Promise<Department[]> => fetchJSON(`${API_BASE}/departments/`);
const fetchRestaurants = (): Promise<Restaurant[]> => fetchJSON(`${API_BASE}/restaurants/`);
function buildCommentQuery(params: Record<string, string>): string {
    return `${API_BASE}/comments/?${new URLSearchParams(params).toString()}`;
}

const mainCommandsKeyboard = Markup.keyboard([
    "/subscribe", "/unsubscribe",
    "/comments"
]);

const multiDeptKeyboard = (depts: Department[], selected: Set<string>) =>
    Markup.inlineKeyboard([
        ...depts.map(d => [Markup.button.callback(`${selected.has(d.id) ? '✅ ' : ''}${d.name}`, `toggle:${d.id}`)]),
        [
            Markup.button.callback(selected.size > 0 ? '✅ Готово' : '🔒 Готово', selected.size > 0 ? 'done' : 'locked'),
            Markup.button.callback('🗑 Отписаться от всех', 'clear_all'),
        ],
    ]);

const unsubscribeKeyboard = (subs: string[]) =>
    Markup.inlineKeyboard([
        ...subs.map(id => [Markup.button.callback(`Отписаться от ${id}`, `unsub:${id}`)]),
        [Markup.button.callback('🗑 Отписаться от всех', 'clear_all')],
    ]);

const commentFilterButtons = [
    Markup.button.callback('📅 Дата', 'filter:date'),
    Markup.button.callback('⭐ Звезды', 'filter:stars'),
    Markup.button.callback('🍽 Ресторан', 'filter:restaurant'),
    Markup.button.callback('🔢 Страницы', 'filter:page_size'),
];
const paginationKeyboardComments = (page: number, hasNext: boolean) =>
    Markup.inlineKeyboard([
        commentFilterButtons,
        [
            ...(page > 1 ? [Markup.button.callback('⬅️ Назад', `cmt:page:${page - 1}`)] : []),
            ...(hasNext ? [Markup.button.callback('Вперед ➡️', `cmt:page:${page + 1}`)] : []),
        ],
    ]);

// == Bot ==
const bot = new Telegraf(BOT_TOKEN!);
bot.catch((err, ctx) => {
    console.error("Bot error:", err);
    ctx.reply("Произошла непредвиденная ошибка. Пожалуйста, попробуйте позже.");
});
// -- Start & Help --
bot.start(async ctx => {
    await ctx.reply('Добро пожаловать!', mainCommandsKeyboard);
    await ctx.reply('Команды:\n/subscribe\n/unsubscribe\n/comments', mainCommandsKeyboard);
    return sendDeptSelection(ctx);
});

// -- Subscribe --
async function sendDeptSelection(ctx: any) {
    const chatId = String(ctx.chat.id);
    let sub = storage.get(chatId);
    if (!sub) {
        sub = { departments: new Set(), lastChecked: new Date(0).toISOString() };
        storage.set(chatId, sub);
    }
    const depts = await fetchDepartments();
    await ctx.reply('Выберите департамент:', multiDeptKeyboard(depts, sub.departments));
}
bot.command('subscribe', sendDeptSelection);

bot.action(/toggle:(.+)/, async ctx => {
    const dept = ctx.match![1];
    const chatId = String(ctx.chat!.id);
    const sub = storage.get(chatId)!;
    sub.departments.has(dept) ? sub.departments.delete(dept) : sub.departments.add(dept);
    await saveStorage();
    await ctx.editMessageReplyMarkup(
        multiDeptKeyboard(await fetchDepartments(), sub.departments).reply_markup
    );
    await ctx.answerCbQuery();
    // если ровно один - сохраняем как department_ids
    if (sub.departments.size === 1) {
        userFilters.set(chatId, { department_ids: [...sub.departments] });
    }
});
bot.action('done', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('Подписка сохранена.');
});
bot.action('locked', ctx => ctx.answerCbQuery('Выберите департамент.'));
bot.action('clear_all', async ctx => {
    const chatId = String(ctx.chat!.id);
    storage.get(chatId)!.departments.clear();
    await saveStorage();
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined);
});

// -- Unsubscribe --
bot.command('unsubscribe', async ctx => {
    const chatId = String(ctx.chat.id);
    const sub = storage.get(chatId);
    if (!sub || !sub.departments.size) return ctx.reply('Нет подписок.');
    await ctx.reply('Отписаться от:', unsubscribeKeyboard([...sub.departments]));
});
bot.action(/unsub:(.+)/, async ctx => {
    const dept = ctx.match![1];
    const chatId = String(ctx.chat!.id);
    storage.get(chatId)!.departments.delete(dept);
    await saveStorage();
    await ctx.answerCbQuery(`Отписались от ${dept}`);
});

// -- Send Comments --
const sendCommentCommand = async (c: Comment, chatId: number, restMap: Map<string, string>) => {
    const name = restMap.get(String(c.restaurant)) || String(c.restaurant);
    await bot.telegram.sendMessage(
        chatId,
        `${'★'.repeat(c.stars)}\nРесторан: ${name}\nАвтор: ${c.name}\nДата: ${c.created_at.split('T')[0]}\n\n${c.text}`,
        c.profile_url ? Markup.inlineKeyboard([Markup.button.url('Профиль автора', c.profile_url)]) : undefined
    );
};

async function sendComments(ctx: any) {
    const chatId = String(ctx.chat.id);
    const f = userFilters.get(chatId);
    let dep = f?.department_ids?.filter(Boolean);
    if (!dep?.length) {
        const sub = storage.get(chatId)!;
        dep = [...sub.departments].filter(Boolean);
    }
    if (!dep?.length) {
        return ctx.reply('Сначала выберите департамент через /subscribe.');

    }
    for (const d of dep) {
        try {
            const params: Record<string, string> = { department_id: d, page: '1' };
            if (f?.restaurant_id) params.restaurant = f.restaurant_id;
            if (f?.created_at_after) params.created_at_after = f.created_at_after;
            if (f?.created_at_before) params.created_at_before = f.created_at_before;
            if (f?.stars) params.stars = f.stars;
            params.page_size = f?.page_size || String(DEFAULT_PAGE_SIZE);

            const cont = await fetchJSON<CommentContainer>(buildCommentQuery(params));
            const rms = await fetchRestaurants();
            const rm = new Map(rms.map(r => [String(r.id), r.name]));
            for (const c of cont.results) {
                await sendCommentCommand(c, Number(chatId), rm);
            }
            await saveStorage();
            await ctx.reply(
                `Страница 1 из ${cont.count}`,
                paginationKeyboardComments(1, !!cont.next)
            );
        } catch { }
    }
}

bot.command('comments', sendComments);

// -- Pagination --
bot.action(/cmt:page:(\d+)/, async ctx => {
    const page = Number(ctx.match![1]);
    const chatId = String(ctx.chat!.id);
    const f = userFilters.get(chatId)!;
    f.page_size = f?.page_size || String(DEFAULT_PAGE_SIZE);
    const params = { ...f, page: String(page) };
    await sendComments(ctx);
    await ctx.answerCbQuery();
});

// -- Comment Commands & Filters --
bot.action('filter:date', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply('Введите диапазон даты YYYY-MM-DD:YYYY-MM-DD');
    userAwaiting.set(String(ctx.chat!.id), 'filter:date');
});
bot.action('filter:stars', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply('Введите количество звёзд');
    userAwaiting.set(String(ctx.chat!.id), 'filter:stars');
});
bot.action('filter:restaurant', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply('Введите ID ресторана');
    userAwaiting.set(String(ctx.chat!.id), 'filter:restaurant');
});
bot.action('filter:page_size', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply('Введите количество отзывов на страницу');
    userAwaiting.set(String(ctx.chat!.id), 'filter:page_size');
});

bot.on('text', async ctx => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    console.log(text);
    const chatId = String(ctx.chat.id);

    const mode = userAwaiting.get(chatId);
    if (!mode) return;
    const input = ctx.message.text.trim();
    const filters = userFilters.get(chatId)!;

    switch (mode) {
        case 'filter:date': {
            const m = input.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
            if (!m) return ctx.reply('Неверный формат даты.');
            filters.created_at_after = m[1];
            filters.created_at_before = m[2];
            break;
        }
        case 'filter:stars': {
            const m = input.match(/^(\d)(?:-(\d))?$/);
            if (!m) return ctx.reply('Введите число 1-5 или диапазон 1-5.');
            filters.stars = m[1];
            break;
        }
        case 'filter:restaurant':
            filters.restaurant_id = input;
            break;
        case 'filter:page_size':
            if (!/^[1-9]\d*$/.test(input)) return ctx.reply('Введите положительное число.');
            filters.page_size = input;
            break;
    }
    userFilters.set(chatId, filters);
    userAwaiting.delete(chatId);
    await ctx.reply('Фильтр сохранён.');
});

// -- Polling ==
setInterval(async () => {
    for (const [chatId, sub] of storage.entries()) {
        for (const d of sub.departments) {
            try {
                const params = { department_id: d, page: '1', page_size: String(DEFAULT_PAGE_SIZE), created_at_after: sub.lastChecked };
                const cont = await fetchJSON<CommentContainer>(buildCommentQuery(params));
                const rms = await fetchRestaurants();
                const rm = new Map(rms.map(r => [String(r.id), r.name]));
                for (const c of cont.results) {
                    await sendCommentCommand(c, Number(chatId), rm);
                }
                sub.lastChecked = new Date().toISOString();
                await saveStorage();
            } catch { }
        }
    }
}, CHECK_INTERVAL);

// -- Webhook ==
(async () => {
    await loadStorage();
    const app = express();
    app.use(express.json());
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
    app.post('/webhook', (req, res) => bot.handleUpdate(req.body, res));
    app.listen(PORT_NUM);
})();