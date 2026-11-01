// Бизнес уақыт белдеуіндегі күн/сағат (сервер нұсқасындағы server/time.js-пен бірдей).
const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }),
    );
  }
  return formatters.get(timeZone);
}

export function localParts(timeZone, date = new Date()) {
  const p = {};
  for (const { type, value } of formatter(timeZone).formatToParts(date)) p[type] = value;
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, month: day.slice(0, 7), hour: Number(p.hour) % 24 };
}

export const nowIso = () => new Date().toISOString();

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isDay = (s) => typeof s === 'string' && DAY_RE.test(s);
export const isMonth = (s) => typeof s === 'string' && MONTH_RE.test(s);

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
