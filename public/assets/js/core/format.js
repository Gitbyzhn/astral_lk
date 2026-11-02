import { getLang, t } from './i18n.js';

const numberFmt = new Intl.NumberFormat('ru-RU');
let timeZone;

/** Сервердегі бизнес уақыт белдеуі (мысалы Asia/Almaty) — уақытты бірдей көрсету үшін. */
export function setTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
    timeZone = tz;
  } catch {
    timeZone = undefined;
  }
}

export const num = (n) => numberFmt.format(Math.round(Number(n) || 0));

/** 8000 → «8 000 ₸» */
export const money = (n) => `${num(n)} ₸`;

/** Үлкен сандарды қысқарту: 1 250 000 → «1,3 млн», 25 000 → «25 мың» (ось белгілері үшін). */
export function compact(n) {
  const abs = Math.abs(n);
  const short = (v) => String(Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10).replace('.', ',');
  if (abs >= 1e6) return `${short(n / 1e6)} млн`;
  if (abs >= 1e4) return `${short(n / 1e3)} ${getLang() === 'ru' ? 'тыс' : 'мың'}`;
  return num(n);
}

function parts(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: p.hour, mm: p.minute };
}

/** ISO → «15:42» */
export function time(iso) {
  if (!iso) return '';
  const p = parts(iso);
  return `${p.hh}:${p.mm}`;
}

/** 'YYYY-MM-DD' → «1 қараша 2026» */
export function dayLabel(day, { year = true } = {}) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${t('months')[m - 1]}${year ? ` ${y}` : ''}`;
}

/** 'YYYY-MM' → «Қараша 2026» */
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${t('months_title')[m - 1]} ${y}`;
}

/** ISO → «1 қараша, 15:42» */
export function dateTime(iso) {
  if (!iso) return '';
  const p = parts(iso);
  return `${p.d} ${t('months')[p.m - 1]}, ${p.hh}:${p.mm}`;
}

/** Бизнес уақыт белдеуіндегі бүгінгі күн: 'YYYY-MM-DD' */
export function todayKey() {
  const p = parts(new Date().toISOString());
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** «3 мин бұрын» */
export function ago(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t('just_now');
  if (mins < 120) return t('minutes_ago', { n: mins });
  return time(iso);
}

/** Тапсырыстың қысқаша мазмұны: «Ересек ×3 · Балалар ×2» (бір түр әртүрлі төлеммен бөлінсе де — бір рет). */
export function itemsSummary(items) {
  const merged = new Map();
  for (const item of items) merged.set(item.name, (merged.get(item.name) ?? 0) + item.qty);
  return [...merged].map(([name, qty]) => `${name} ×${qty}`).join(' · ');
}

/**
 * Төлем түрлері бойынша сомалар: [{ id, name, sum, qty }] (бірінші кездескен ретпен).
 * Төлем түрі жоқ ескі жолдар id: null болып бір топқа түседі.
 */
export function paymentTotals(items) {
  const totals = new Map();
  for (const item of items) {
    const id = item.paymentMethodId ?? null;
    const row = totals.get(id) ?? { id, name: item.paymentName ?? null, sum: 0, qty: 0 };
    row.sum += item.qty * item.price;
    row.qty += item.qty;
    totals.set(id, row);
  }
  return [...totals.values()];
}
