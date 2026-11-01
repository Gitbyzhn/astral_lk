// Клиент сканерлеген талондар телефонның өзінде сақталады (тіркелусіз).
const KEY = 'astral.tickets';
const LIMIT = 20;

export function savedTickets() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.code === 'string') : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
  } catch {
    /* жеке режимде localStorage болмауы мүмкін */
  }
}

/** Талонды сақтайды/жаңартады; кезектегі ең үлкен «алдыңызда» санын да есте сақтайды (прогресс үшін). */
export function rememberTicket(order, ahead) {
  const list = savedTickets();
  const prev = list.find((x) => x.code === order.code);
  const entry = {
    code: order.code,
    number: order.number,
    day: order.day,
    createdAt: order.createdAt,
    maxAhead: Math.max(prev?.maxAhead ?? 0, ahead ?? 0),
  };
  write([entry, ...list.filter((x) => x.code !== order.code)]);
  return entry;
}

export function forgetTicket(code) {
  write(savedTickets().filter((x) => x.code !== code));
}
