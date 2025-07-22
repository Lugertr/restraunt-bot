"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureCache = ensureCache;
exports.sendInlineKeyboard = sendInlineKeyboard;
exports.sendSkipCancel = sendSkipCancel;
exports.clearPrevious = clearPrevious;
exports.ensureSettingsFile = ensureSettingsFile;
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
const telegraf_1 = require("telegraf");
const fs_1 = require("fs");
// Кэширование API-данных: если нет в sessionCache, получить через fetcher и сохранить
async function ensureCache(sessionCache, chatId, key, fetcher) {
    try {
        let cache = sessionCache.get(chatId)?.[key];
        if (!cache) {
            cache = await fetcher();
            sessionCache.set(chatId, { ...sessionCache.get(chatId), [key]: cache });
        }
        return cache;
    }
    catch (e) {
        console.error("Ошибка ensureCache:", e);
        throw e;
    }
}
// Отправка inline-клавиатуры с заданным числом колонок
async function sendInlineKeyboard(ctx, text, buttons, columns = 2) {
    try {
        return await ctx.reply(text, telegraf_1.Markup.inlineKeyboard(buttons, { columns }));
    }
    catch (e) {
        console.error("Ошибка sendInlineKeyboard:", e);
    }
}
// Отправка сообщения с кнопками Пропустить и Отмена
async function sendSkipCancel(ctx, text, skipBtn, cancelBtn) {
    try {
        return await ctx.reply(text, telegraf_1.Markup.inlineKeyboard([[skipBtn, cancelBtn]]));
    }
    catch (e) {
        console.error("Ошибка sendSkipCancel:", e);
    }
}
// Удаление предыдущих сообщений при пагинации
async function clearPrevious(ctx, userMessages, chatId) {
    try {
        const prev = userMessages.get(chatId) || [];
        for (const msgId of prev) {
            try {
                await ctx.deleteMessage(msgId);
            }
            catch { }
        }
        userMessages.set(chatId, []);
    }
    catch (e) {
        console.error("Ошибка clearPrevious:", e);
    }
}
async function ensureSettingsFile(filePath) {
    try {
        await fs_1.promises.access(filePath);
    }
    catch {
        try {
            await fs_1.promises.writeFile(filePath, JSON.stringify({}, null, 2));
        }
        catch (e) {
            console.error("Ошибка ensureSettingsFile:", e);
        }
    }
}
// Чтение JSON-файла и парсинг в объект
async function readJsonFile(filePath) {
    try {
        const data = await fs_1.promises.readFile(filePath, "utf8");
        return JSON.parse(data);
    }
    catch (e) {
        console.error("Ошибка readJsonFile:", e);
        throw e;
    }
}
// Запись объекта в JSON-файл
async function writeJsonFile(filePath, data) {
    try {
        await fs_1.promises.writeFile(filePath, JSON.stringify(data, null, 2));
    }
    catch (e) {
        console.error("Ошибка writeJsonFile:", e);
    }
}
