import { Markup } from "telegraf";
import { promises as fs } from "fs";

// Кэширование API-данных: если нет в sessionCache, получить через fetcher и сохранить
export async function ensureCache<T>(
    sessionCache: Map<string, any>,
    chatId: string,
    key: string,
    fetcher: () => Promise<T>
): Promise<T> {
    try {
        let cache = sessionCache.get(chatId)?.[key];
        if (!cache) {
            cache = await fetcher();
            sessionCache.set(chatId, { ...sessionCache.get(chatId), [key]: cache });
        }
        return cache;
    } catch (e) {
        console.error("Ошибка ensureCache:", e);
        throw e;
    }
}

// Отправка inline-клавиатуры с заданным числом колонок
export async function sendInlineKeyboard(
    ctx: any,
    text: string,
    buttons: any[],
    columns = 2
) {
    try {
        return await ctx.reply(text, Markup.inlineKeyboard(buttons, { columns }));
    } catch (e) {
        console.error("Ошибка sendInlineKeyboard:", e);
    }
}

// Отправка сообщения с кнопками Пропустить и Отмена
export async function sendSkipCancel(
    ctx: any,
    text: string,
    skipBtn: any,
    cancelBtn: any
) {
    try {
        return await ctx.reply(text, Markup.inlineKeyboard([[skipBtn, cancelBtn]]));
    } catch (e) {
        console.error("Ошибка sendSkipCancel:", e);
    }
}

// Удаление предыдущих сообщений при пагинации
export async function clearPrevious(
    ctx: any,
    userMessages: Map<string, number[]>,
    chatId: string
) {
    try {
        const prev = userMessages.get(chatId) || [];
        for (const msgId of prev) {
            try { await ctx.deleteMessage(msgId); } catch { }
        }
        userMessages.set(chatId, []);
    } catch (e) {
        console.error("Ошибка clearPrevious:", e);
    }
}

// Убедиться, что файл filters.json существует, иначе создать пустой
export async function ensureFiltersFile(filePath: string) {
    try {
        await fs.access(filePath);
    } catch {
        try {
            await fs.writeFile(filePath, JSON.stringify({}, null, 2));
        } catch (e) {
            console.error("Ошибка ensureFiltersFile:", e);
        }
    }
}

// Чтение JSON-файла и парсинг в объект
export async function readJsonFile<T>(filePath: string): Promise<T> {
    try {
        const data = await fs.readFile(filePath, "utf8");
        return JSON.parse(data) as T;
    } catch (e) {
        console.error("Ошибка readJsonFile:", e);
        throw e;
    }
}

// Запись объекта в JSON-файл
export async function writeJsonFile(
    filePath: string,
    data: unknown
): Promise<void> {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Ошибка writeJsonFile:", e);
    }
}
