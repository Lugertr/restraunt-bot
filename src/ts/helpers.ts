export function isFilledArray(v: unknown): boolean {
    return Array.isArray(v) && v.length > 0;
}

export function isValidNumber(value: unknown): value is number {
    return typeof value === "number" && !isNaN(value);
}