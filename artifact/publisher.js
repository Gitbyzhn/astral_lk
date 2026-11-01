/**
 * Клиенттерге арналған жария күйді бетке жазып, жаңа нұсқа ретінде жариялау (artifact.publish).
 * Claude-қа кірмеген клиент деректер базасын оқи алмайды — ол осы бетке салынған күйді көреді,
 * ал жаңа нұсқа жарияланғанда барлық ашық беттер өздігінен жаңарады.
 *
 * Жариялағаннан кейін әкімші беті де қайта жүктеледі, сондықтан:
 *   • тек кезек өзгергенде (шақыру, болдырмау…) жарияланады — жаңа талон бергенде емес;
 *   • әкімші бос тұрғанда ғана (терезе ашық емес, касса бос, 4 с әрекетсіз);
 *   • екі жариялау арасы кемінде 20 с (бірнеше өзгеріс біреуіне жиналады).
 */
import { h, mount } from '../public/assets/js/core/dom.js';
import { icon } from '../public/assets/js/core/icons.js';
import { t } from '../public/assets/js/core/i18n.js';
import { todayKey } from '../public/assets/js/core/format.js';
import { store as adminStore } from '../public/assets/js/admin/shared.js';
import { runtime } from './runtime.js';
import { data } from './store.js';
import { buildSnapshot, snapshotKey } from './domain.js';
import { renderDocument } from './template.js';

const GAP_MS = Number(window.__ASTRAL_PUBLISH_GAP ?? 20_000);
const IDLE_MS = Number(window.__ASTRAL_PUBLISH_IDLE ?? 4_000);
const LAST_KEY = 'astral.lastPublish';

let dirty = false;
let disabled = false;
let failed = false;
let timer = null;
let lastInteraction = 0;
const listeners = new Set();

for (const type of ['pointerdown', 'keydown', 'input']) {
  addEventListener(type, () => (lastInteraction = Date.now()), true);
}

const notify = () => {
  for (const fn of listeners) fn();
};

function lastPublishAt() {
  try {
    return Number(sessionStorage.getItem(LAST_KEY) || 0);
  } catch {
    return 0;
  }
}
function rememberPublish() {
  try {
    sessionStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    /* сақтау орны жабық */
  }
}

/** Бетке салынған (қазір жарияланып тұрған) жария күй. */
export function embeddedSnapshot() {
  try {
    return JSON.parse(document.getElementById('astral-public')?.textContent || 'null');
  } catch {
    return null;
  }
}

export function currentSnapshot() {
  return buildSnapshot({
    days: data.days,
    catalog: data.catalog,
    settings: data.settings,
    today: todayKey(),
    timeZone: data.settings.timeZone || 'Asia/Almaty',
  });
}

const differsFromPage = () => snapshotKey(currentSnapshot()) !== snapshotKey(embeddedSnapshot() ?? {});

/** Кезек немесе атаулар өзгерді — клиенттер бетін жаңарту керек. */
export function markDirty() {
  if (!runtime.artifact) return;
  dirty = true;
  if (disabled) return notify();
  failed = false;
  notify();
  schedule(1500);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => attempt(false), ms);
}

const busy = () =>
  Date.now() - lastInteraction < IDLE_MS || document.querySelector('.modal-backdrop') !== null || adminStore.cart.size > 0;

async function attempt(force) {
  if (!dirty || disabled || !runtime.artifact) return;
  if (!force) {
    const wait = GAP_MS - (Date.now() - lastPublishAt());
    if (wait > 0) return schedule(wait + 200);
    if (busy()) return schedule(1500);
  }
  if (!differsFromPage()) {
    dirty = false;
    notify();
    return;
  }
  const snapshot = { ...currentSnapshot(), at: new Date().toISOString() };
  const html = renderDocument({
    css: document.getElementById('astral-css')?.textContent ?? '',
    js: document.getElementById('astral-app')?.textContent ?? '',
    state: snapshot,
    title: `${snapshot.business} кезегі`,
  });
  rememberPublish();
  try {
    await runtime.artifact.publish(html);
    // Сәтті болса, бет өзі қайта жүктеледі.
  } catch (err) {
    const code = err?.code;
    if (code === 'conflict') return; // басқа нұсқа жарияланды — бет соған қайта жүктеледі
    if (['not_writer', 'not_granted', 'not_declared', 'capability_disabled', 'capability_removed', 'consent_required'].includes(code)) {
      disabled = true;
    } else {
      failed = true;
      schedule(code === 'rate_limited' ? 60_000 : 30_000);
    }
    console.warn('publish', code, err?.message);
    notify();
  }
}

/** «Қазір жаңарту» түймесі. */
export const publishNow = () => attempt(true);

/** Әкімші бетінің жоғарғы жағындағы шағын күй жолағы. */
export function publishChip() {
  if (!runtime.artifact) return null;
  const el = h('div');
  let shown = false;
  const draw = () => {
    // Қабық қайта сызылса, ескі элементтің тыңдаушысын алып тастаймыз
    if (shown && !el.isConnected) return listeners.delete(draw);
    shown = shown || el.isConnected;
    if (disabled) {
      return mount(el, dirty ? h('div', { class: 'notice' }, icon('alert'), h('span', null, t('publish_disabled'))) : null);
    }
    if (!dirty && !failed) return mount(el);
    mount(
      el,
      h(
        'div',
        { class: 'notice', style: failed ? {} : { background: 'var(--primary-soft)', borderColor: 'rgba(59,124,255,.3)', color: '#cfe0ff' } },
        icon(failed ? 'alert' : 'refresh'),
        h('span', { style: { flex: '1' } }, failed ? t('publish_error') : t('publish_pending')),
        h('button', { class: 'btn btn-soft btn-sm', onclick: (e) => ((e.currentTarget.disabled = true), publishNow()) }, t('publish_now')),
      ),
    );
  };
  listeners.add(draw);
  draw();
  return el;
}
