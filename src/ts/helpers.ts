export function isFilledArray(v: unknown): boolean {
    return Array.isArray(v) && v.length > 0;
}

export function isValidNumber(value: unknown): value is number {
    return typeof value === "number" && !isNaN(value);
}

export function formatDateLocal(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}