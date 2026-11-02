import { h } from './dom.js';
import { icon } from './icons.js';
import { getLang, setLang, t } from './i18n.js';
import { LOGO_FULL_URL, LOGO_URL } from './logo.js';

/* ------------------------------ Toast ------------------------------ */
let toastRoot;

/**
 * @param {string} message
 * @param {'success' | 'error' | 'info'} [kind]
 */
export function toast(message, kind = 'success') {
  toastRoot ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const name = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'bell';
  const el = h('div', { class: `toast ${kind}` }, icon(name), h('span', null, message));
  toastRoot.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

/* ------------------------------ Modal ------------------------------ */
const openModals = [];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) openModals.at(-1).close();
});

/**
 * Модаль терезе (телефонда — төменнен шығатын парақ).
 * @param {{ title?: string, body: Node | Node[], footer?: Node | Node[], wide?: boolean, onClose?: () => void, dismissible?: boolean }} options
 */
export function openModal({ title, body, footer, wide = false, onClose, dismissible = true }) {
  const previousFocus = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2, 8)}`;

  const modal = h(
    'div',
    { class: ['modal', wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null },
    title &&
      h(
        'div',
        { class: 'modal-head' },
        h('h2', { id: titleId }, title),
        h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': t('close'), onclick: () => api.close() }, icon('x')),
      ),
    h('div', { class: 'modal-body' }, body),
    footer && h('div', { class: 'modal-foot' }, footer),
  );

  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) api.close();
  });

  const api = {
    el: modal,
    close() {
      const i = openModals.indexOf(api);
      if (i === -1) return;
      openModals.splice(i, 1);
      backdrop.remove();
      if (!openModals.length) document.body.style.overflow = '';
      previousFocus?.focus?.({ preventScroll: true });
      onClose?.();
    },
  };

  openModals.push(api);
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    const target = modal.querySelector('[autofocus]') || modal.querySelector('.modal-body input, .modal-foot .btn-primary');
    target?.focus?.({ preventScroll: true });
  });
  return api;
}

/** Растау терезесі. Promise<boolean> қайтарады. */
export function confirmDialog({ title, message, confirmText = t('confirm'), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const modal = openModal({
      title,
      body: h('p', { class: 'muted' }, message),
      footer: [
        h('button', { class: 'btn btn-ghost', onclick: () => modal.close() }, t('cancel')),
        h(
          'button',
          {
            class: ['btn', danger ? 'btn-danger' : 'btn-primary'],
            autofocus: true,
            onclick: () => {
              result = true;
              modal.close();
            },
          },
          confirmText,
        ),
      ],
      onClose: () => resolve(result),
    });
  });
}

/* --------------------------- Шағын компоненттер --------------------------- */

/** KZ / RU ауыстырғышы. */
export function langToggle() {
  const make = (code, label) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(getLang() === code),
        onclick: () => setLang(code),
      },
      label,
    );
  return h('div', { class: 'lang-toggle', role: 'group', 'aria-label': t('language') }, make('kk', 'ҚАЗ'), make('ru', 'РУС'));
}

/** Күй белгісі: түс + мәтін. */
export const statusChip = (status) => h('span', { class: `chip chip-${status}` }, t(`status_${status}`));

/** Бренд белгісі (логотип + атау). */
export function brand(name, sub) {
  return h(
    'div',
    { class: 'brand' },
    h('img', { class: 'brand-logo', src: LOGO_URL, alt: '', width: 36, height: 36 }),
    h('div', { class: 'brand-name' }, name, sub && h('span', { class: 'brand-sub' }, sub)),
  );
}

/** Үлкен логотип (кіру беттері, клиенттің басты беті): толық бренд суреті және астында қысқа жазу. */
export function brandHero(name, sub, { size = 168 } = {}) {
  return h(
    'div',
    { class: 'brand-hero' },
    h('img', { class: 'brand-hero-img', src: LOGO_FULL_URL, alt: name, width: size, height: size, style: { width: `${size}px` } }),
    sub && h('div', { class: 'brand-hero-sub' }, sub),
  );
}

export function emptyState({ iconName = 'ticket', title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName)),
    h('h3', null, title),
    text && h('p', null, text),
    action,
  );
}

export const spinner = () => h('div', { class: 'center-fill' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('loading') }));

/** Түймені сұрау кезінде бұғаттайды. */
export async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

/** Мәтінді көшіру (ескі браузерлерге резервтік жолмен). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = h('textarea', { class: 'sr-only' });
    input.value = text;
    document.body.append(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}
