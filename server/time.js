import { config } from './config.js';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * Берілген сәттің бизнес уақыт белдеуіндегі күні мен сағаты.
 * @param {Date} [date]
 * @returns {{ day: string, month: string, hour: number }}
 */
export function localParts(date = new Date()) {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) p[type] = value;
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, month: day.slice(0, 7), hour: Number(p.hour) % 24 };
}

export const today = () => localParts().day;

export const nowIso = () => new Date().toISOString();

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isDay = (s) => typeof s === 'string' && DAY_RE.test(s);
export const isMonth = (s) => typeof s === 'string' && MONTH_RE.test(s);

/** Айдағы күндер саны, мысалы '2026-02' → 28. */
export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** '2026-01' → '2026-02' */
export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
