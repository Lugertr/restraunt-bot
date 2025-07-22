"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFilledArray = isFilledArray;
exports.isValidNumber = isValidNumber;
exports.formatDateLocal = formatDateLocal;
function isFilledArray(v) {
    return Array.isArray(v) && v.length > 0;
}
function isValidNumber(value) {
    return typeof value === "number" && !isNaN(value);
}
function formatDateLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
