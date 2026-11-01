/**
 * Claude деректер базасымен жұмыс (тек әкімшіде). Құжаттар:
 *   meta/catalog   — { types: { <id>: { name, price, description, color, active, sort, deleted } } }
 *   meta/settings  — { businessName, publicUrl, timeZone }
 *   days/<күн>     — { day, orders: { <id>: тапсырыс } }   (бүгін және кеше тікелей бақыланады)
 *   stats/<күн>    — бір күннің жиынтығы (есептер үшін)
 * Бір құжатқа бір уақытта бір жазу; объектілер біріктіріліп (merge) жазылады — бірнеше құрылғы
 * әртүрлі тапсырысты қатар өзгертсе де бір-бірін өшірмейді.
 */
import { runtime } from './runtime.js';
import { aggregateDay, shiftDay } from './domain.js';

export const data = {
  catalog: { types: {} },
  settings: {},
  days: {},
  ready: false,
  error: null,
};

const listeners = new Set();
export const onData = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (type) => {
  for (const fn of listeners) {
    try {
      fn(type);
    } catch (err) {
      console.error(err);
    }
  }
};

export const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/** db.update сияқты терең біріктіру: объектілер ішкі деңгейде, қалғаны (массив, сан) ауыстырылады. */
export function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (isObject(value) && isObject(target[key])) deepMerge(target[key], value);
    else target[key] = clone(value);
  }
  return target;
}

/* ------------------------------ Жазу (кезекпен) ------------------------------ */
const chains = new Map();
function serial(path, task) {
  const run = (chains.get(path) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(path, run);
  return run;
}

/** Біріктіріп жазу; құжат әлі жоқ болса — жасайды. `local` берілсе, экранға бірден қолданылады. */
export function mergeDoc(path, patch, local) {
  if (local) deepMerge(local, patch);
  return serial(path, async () => {
    const ref = runtime.db.doc(path);
    try {
      await ref.update(patch);
    } catch (err) {
      if (err?.code !== 'invalid_argument') throw err;
      const snap = await ref.get();
      if (snap.exists) throw err;
      await ref.set(patch);
    }
  });
}

export const setDoc = (path, body) => serial(path, () => runtime.db.doc(path).set(body));

/** Бірнеше құрылғы қатар талон берсе, нөмір қайталанбауы үшін қысқа «құлып». */
const TAB = `tab-${Math.random().toString(36).slice(2, 10)}`;
export async function withLock(path, fn) {
  const ref = runtime.db.doc(path);
  if (typeof ref.acquire !== 'function') return fn();
  for (let attempt = 0; attempt < 24; attempt++) {
    let result;
    try {
      result = await ref.acquire({ holder: TAB, ttlMs: 4000 });
    } catch {
      return fn();
    }
    if (result?.acquired) return fn();
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
  }
  return fn();
}

/* --------------------------- Күн жиынтығын жазу --------------------------- */
const statsTimers = new Map();
const statsWritten = new Map();
export function scheduleStats(day) {
  clearTimeout(statsTimers.get(day));
  statsTimers.set(
    day,
    setTimeout(() => {
      statsTimers.delete(day);
      const doc = data.days[day];
      if (!doc) return;
      const body = aggregateDay(day, doc);
      const json = JSON.stringify(body);
      if (statsWritten.get(day) === json) return;
      statsWritten.set(day, json);
      setDoc(`stats/${day}`, body).catch((err) => console.warn('stats', err?.code));
    }, 1500),
  );
}

/* ------------------------------ Тікелей бақылау ------------------------------ */
let watched = [];
let dayUnsubs = [];
let todayFn = () => new Date().toISOString().slice(0, 10);

function onError(err) {
  data.error = err?.code || 'unavailable';
  console.warn('db', err?.code, err?.message);
  emit('error');
}

function normalizeDay(body, day) {
  return { day, ...body, orders: body?.orders ?? {} };
}

export const watchedDays = () => watched.slice();

function watchDays() {
  const today = todayFn();
  const want = [today, shiftDay(today, -1)];
  if (want.join() === watched.join()) return;
  for (const off of dayUnsubs) off();
  dayUnsubs = [];
  watched = want;
  for (const day of want) {
    data.days[day] ??= { day, orders: {} };
    dayUnsubs.push(
      runtime.db.doc(`days/${day}`).onSnapshot((snap) => {
        data.days[day] = snap.exists ? normalizeDay(clone(snap.data()), day) : { day, orders: {} };
        emit('queue');
      }, onError),
    );
  }
  // Бақыланбайтын ескі күндерді жадтан шығарамыз
  for (const day of Object.keys(data.days)) if (!want.includes(day)) delete data.days[day];
}

/** Деректерге жазылу; алғашқы жауапты (ең көбі 10 с) күтеді. */
export function startStore({ today }) {
  todayFn = today;
  const db = runtime.db;
  return new Promise((resolve) => {
    let pending = 3;
    const settle = () => {
      if (--pending <= 0 && !data.ready) {
        data.ready = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      data.ready = true;
      resolve();
    }, 10_000);

    let first = { catalog: true, settings: true, day: true };
    db.doc('meta/catalog').onSnapshot((snap) => {
      data.catalog = snap.exists ? clone(snap.data()) : { types: {} };
      data.catalog.types ??= {};
      emit('types');
      if (first.catalog) (first.catalog = false), settle();
    }, onError);
    db.doc('meta/settings').onSnapshot((snap) => {
      data.settings = snap.exists ? clone(snap.data()) : {};
      emit('settings');
      if (first.settings) (first.settings = false), settle();
    }, onError);

    watchDays();
    const off = onData((type) => {
      if (type === 'queue' && first.day) {
        first.day = false;
        off();
        settle();
      }
    });
    setInterval(watchDays, 60_000);
  });
}

/** Есептер үшін: бір рет оқу (тікелей бақыланбайды). */
export async function readStats(filter) {
  let query = runtime.db.collection('stats');
  if (filter?.day) query = query.where('day', '==', filter.day);
  else if (filter?.month) query = query.where('month', '==', filter.month);
  const snap = await query.get();
  return snap.docs.filter((d) => d.exists).map((d) => clone(d.data()));
}
