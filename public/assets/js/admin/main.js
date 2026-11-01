import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { onLangChange, t } from '../core/i18n.js';
import { api, auth } from '../core/api.js';
import { setTimeZone } from '../core/format.js';
import { connectLive } from '../core/live.js';
import { createRouter } from '../core/router.js';
import { registerServiceWorker } from '../core/pwa.js';
import { brand, confirmDialog, langToggle, spinner } from '../core/ui.js';
import { store } from './shared.js';
import { loginView } from './login.js';
import { cashierPage } from './cashier.js';
import { queuePage } from './queue.js';
import { typesPage } from './types.js';
import { reportsPage } from './reports.js';
import { settingsPage } from './settings.js';

const root = document.getElementById('app');

const NAV = [
  { path: '/admin', icon: 'ticket', label: () => t('cashier'), page: cashierPage },
  { path: '/admin/queue', icon: 'queue', label: () => t('queue'), page: queuePage, badge: true },
  { path: '/admin/types', icon: 'tag', label: () => t('tickets_nav'), page: typesPage },
  { path: '/admin/reports', icon: 'chart', label: () => t('reports'), page: reportsPage },
  { path: '/admin/settings', icon: 'sliders', label: () => t('settings'), page: settingsPage },
];

let current = null; // { page, path }
let shell = null;
let stopLive = null;
let waitingCount = 0;
let online = false;

const router = createRouter([...NAV.map((item) => ({ path: item.path, item })), { path: '*' }], ({ route }) => {
  if (!shell) return; // кіру беті ашық тұрғанда (мысалы, «Артқа» басылса) — ештеңе істемейміз
  if (!route?.item) return router.navigate('/admin', { replace: true });
  showPage(route.item);
});

/* ------------------------------- Қабық ------------------------------- */
function buildShell() {
  const links = (cls) =>
    NAV.map((item) =>
      h(
        'a',
        { href: item.path, 'data-link': true, 'data-path': item.path, class: cls },
        icon(item.icon),
        h('span', null, item.label()),
        item.badge && h('span', { class: 'badge', 'data-badge': true, hidden: true }),
      ),
    );

  const liveBadge = () => h('span', { class: 'live', 'data-live': true }, t('live'));
  const logoutBtn = (extra = '') =>
    h('button', { class: `btn btn-ghost ${extra}`, onclick: logout, 'aria-label': t('logout'), title: t('logout') }, icon('logout'), extra ? null : t('logout'));

  const view = h('main', { class: 'main', id: 'view' });
  const el = h(
    'div',
    { class: 'admin' },
    h(
      'aside',
      { class: 'sidebar' },
      brand(store.info.businessName, t('admin_panel')),
      h('nav', { class: 'nav' }, links('')),
      h('div', { class: 'sidebar-foot' }, h('div', { class: 'row' }, langToggle(), h('div', { class: 'spacer' }), liveBadge()), logoutBtn()),
    ),
    h(
      'div',
      { style: { minWidth: '0' } },
      h('header', { class: 'topbar' }, brand(store.info.businessName, t('admin_panel')), h('div', { class: 'spacer' }), liveBadge(), h('span', { class: 'topbar-lang' }, langToggle())),
      store.passwordIsDefault &&
        h(
          'div',
          { class: 'shell-notice', 'data-notice': true },
          h('a', { class: 'notice', href: '/admin/settings', 'data-link': true, style: { textDecoration: 'none' } }, icon('alert'), t('default_password_warning')),
        ),
      view,
    ),
    h('nav', { class: 'tabbar' }, links('')),
  );
  return { el, view };
}

function updateChrome() {
  if (!shell) return;
  for (const a of shell.el.querySelectorAll('a[data-path]')) {
    a.classList.toggle('active', a.dataset.path === current?.path);
    if (a.dataset.path === current?.path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  for (const badge of shell.el.querySelectorAll('[data-badge]')) {
    badge.textContent = String(waitingCount);
    badge.hidden = waitingCount === 0;
  }
  // «Баптаулар» бетінде ескерту құпиясөз картасының ішінде көрсетіледі
  const notice = shell.el.querySelector('[data-notice]');
  if (notice) notice.hidden = current?.path === '/admin/settings';
  for (const live of shell.el.querySelectorAll('[data-live]')) {
    live.classList.toggle('on', online);
    live.textContent = online ? t('live') : t('offline');
    live.title = online ? t('live') : t('offline');
  }
}

function setBadge(n) {
  waitingCount = n;
  updateChrome();
}

async function refreshBadge() {
  try {
    const board = await api('/public/board');
    setBadge(board.waiting);
  } catch {
    /* желі жоқ — келесі жолы */
  }
}

function showPage(item) {
  current?.page?.destroy?.();
  const ctx = {
    navigate: (path, opts) => router.navigate(path, opts),
    setBadge,
    onLogout: logout,
    refreshShell: renderShell,
  };
  current = { path: item.path, page: item.page(ctx) };
  mount(shell.view, current.page.el);
  document.title = `${item.label()} · ${store.info.businessName}`;
  updateChrome();
}

function renderShell() {
  shell = buildShell();
  mount(root, shell.el);
  router.resolve();
}

/* ---------------------------- Кіру / шығу ---------------------------- */
function startApp() {
  renderShell();
  refreshBadge();
  stopLive?.();
  stopLive = connectLive(
    (type) => {
      if (type === 'queue' || type === 'resync') refreshBadge();
      if (type === 'settings') loadInfo().then(renderShell);
      current?.page?.onEvent?.(type);
    },
    {
      onStatus: (value) => {
        online = value;
        updateChrome();
      },
    },
  );
}

function showLogin() {
  stopLive?.();
  stopLive = null;
  current?.page?.destroy?.();
  current = null;
  shell = null;
  document.title = `${t('login_title')} · ${store.info.businessName}`;
  mount(root, loginView({ onSuccess: startApp }));
}

async function logout() {
  const ok = await confirmDialog({ title: t('logout'), message: `${t('logout')}?`, confirmText: t('logout'), danger: true });
  if (!ok) return;
  auth.token = null;
  showLogin();
}

async function loadInfo() {
  try {
    store.info = await api('/public/info');
    setTimeZone(store.info.timeZone);
  } catch {
    /* әдепкі мәндер қалады */
  }
}

auth.onUnauthorized(() => showLogin());
onLangChange(() => (shell ? renderShell() : showLogin()));

async function boot() {
  mount(root, spinner());
  registerServiceWorker();
  await loadInfo();
  if (!auth.token) return showLogin();
  try {
    const session = await api('/admin/session');
    store.passwordIsDefault = session.passwordIsDefault;
    store.lanUrls = session.lanUrls ?? [];
    startApp();
  } catch (err) {
    // Желі жоқ болса да қабықты көрсетеміз: беттер байланыс қалпына келгенде жаңарады.
    if (err.status === 401) showLogin();
    else startApp();
  }
}

boot();
