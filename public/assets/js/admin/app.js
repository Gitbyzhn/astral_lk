import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api, auth } from '../core/api.js';
import { setTimeZone } from '../core/format.js';
import { connectLive } from '../core/live.js';
import { registerServiceWorker } from '../core/pwa.js';
import { brand, confirmDialog, langToggle, spinner } from '../core/ui.js';
import { store } from './shared.js';
import { loginView } from './login.js';
import { cashierPage } from './cashier.js';
import { queuePage } from './queue.js';
import { typesPage } from './types.js';
import { reportsPage } from './reports.js';
import { settingsPage } from './settings.js';

export const ADMIN_NAV = [
  { path: '/admin', icon: 'ticket', label: () => t('cashier'), page: cashierPage },
  { path: '/admin/queue', icon: 'queue', label: () => t('queue'), page: queuePage, badge: true },
  { path: '/admin/types', icon: 'tag', label: () => t('tickets_nav'), page: typesPage },
  { path: '/admin/reports', icon: 'chart', label: () => t('reports'), page: reportsPage },
  { path: '/admin/settings', icon: 'sliders', label: () => t('settings'), page: settingsPage },
];

/**
 * Әкімші қосымшасы: қабық (мәзір), беттер, нақты уақыттағы жаңартулар.
 * Маршрутизатор сырттан беріледі (өз сервері — History API, Claude сілтемесі — #hash).
 * @param {{ root: HTMLElement, navigate: (path: string, opts?: object) => void, withAuth?: boolean, extraChrome?: () => Node | null }} options
 */
export function createAdminApp({ root, navigate, withAuth = true, extraChrome = () => null }) {
  let current = null; // { page, path }
  let wanted = null; // маршрутизатор сұраған бет (қабық дайын болмаса да есте сақталады)
  let shell = null;
  let stopLive = null;
  let waitingCount = 0;
  let online = false;

  function buildShell() {
    const links = () =>
      ADMIN_NAV.map((item) =>
        h(
          'a',
          { href: item.path, 'data-link': true, 'data-path': item.path },
          icon(item.icon),
          h('span', null, item.label()),
          item.badge && h('span', { class: 'badge', 'data-badge': true, hidden: true }),
        ),
      );

    const liveBadge = () => h('span', { class: 'live', 'data-live': true }, t('live'));
    const view = h('main', { class: 'main', id: 'view' });
    const el = h(
      'div',
      { class: 'admin' },
      h(
        'aside',
        { class: 'sidebar' },
        brand(store.info.businessName, t('admin_panel')),
        h('nav', { class: 'nav' }, links()),
        h(
          'div',
          { class: 'sidebar-foot' },
          h('div', { class: 'row' }, langToggle(), h('div', { class: 'spacer' }), liveBadge()),
          withAuth && h('button', { class: 'btn btn-ghost', onclick: logout, 'aria-label': t('logout') }, icon('logout'), t('logout')),
        ),
      ),
      h(
        'div',
        { style: { minWidth: '0' } },
        h('header', { class: 'topbar' }, brand(store.info.businessName, t('admin_panel')), h('div', { class: 'spacer' }), liveBadge(), h('span', { class: 'topbar-lang' }, langToggle())),
        (() => {
          const extra = extraChrome();
          return extra && h('div', { class: 'shell-notice' }, extra);
        })(),
        store.passwordIsDefault &&
          h(
            'div',
            { class: 'shell-notice', 'data-notice': true },
            h('a', { class: 'notice', href: '/admin/settings', 'data-link': true, style: { textDecoration: 'none' } }, icon('alert'), t('default_password_warning')),
          ),
        view,
      ),
      h('nav', { class: 'tabbar' }, links()),
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
    const ctx = { navigate, setBadge, onLogout: logout, refreshShell: renderShell };
    current = { path: item.path, page: item.page(ctx) };
    mount(shell.view, current.page.el);
    document.title = `${item.label()} · ${store.info.businessName}`;
    updateChrome();
  }

  function renderShell() {
    current?.page?.destroy?.();
    current = null;
    shell = buildShell();
    mount(root, shell.el);
    if (wanted) showPage(wanted);
  }

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
        mode: store.info.realtime,
        onStatus: (value) => {
          online = value;
          updateChrome();
        },
      },
    );
  }

  function showLogin(error = null) {
    stopLive?.();
    stopLive = null;
    current?.page?.destroy?.();
    current = null;
    shell = null;
    document.title = `${t('login_title')} · ${store.info.businessName}`;
    mount(root, loginView({ onSuccess: startApp, error }));
  }

  /** Әкімші сілтемесі (/admin#key=…): кілтті сессияға айырбастап, мекенжайдан өшіреміз. */
  async function loginFromLink() {
    const key = new URLSearchParams(location.hash.slice(1)).get('key');
    if (!key) return null;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      /* мекенжайды өзгерту мүмкін болмаса да жалғастырамыз */
    }
    try {
      const result = await api('/auth/key', { method: 'POST', body: { key } });
      auth.token = result.token;
      store.passwordIsDefault = result.passwordIsDefault;
      return null;
    } catch (err) {
      return err;
    }
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

  if (withAuth) auth.onUnauthorized(() => showLogin());

  return {
    /** Бастапқы жүктеу: баптаулар, кіру тексерісі, қабық. */
    async start() {
      mount(root, spinner());
      registerServiceWorker();
      await loadInfo();
      const linkError = withAuth ? await loginFromLink() : null;
      if (linkError) return showLogin(linkError);
      if (withAuth && !auth.token) return showLogin();
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
    },

    /** Маршрутизатор бетті ауыстырғанда шақырылады. */
    show(item) {
      wanted = item;
      if (shell) showPage(item);
    },

    /** Тіл ауысқанда қайта сызу. */
    rerender() {
      if (shell) renderShell();
      else if (withAuth) showLogin();
    },

    stop() {
      stopLive?.();
      stopLive = null;
      current?.page?.destroy?.();
      current = null;
      shell = null;
    },
  };
}
