/**
 * Astral — Claude сілтемесі (artifact) нұсқасының кіру нүктесі.
 * Иесі (немесе редактор) → әкімші: касса, кезек, билеттер, есеп, баптаулар (Claude деректер базасы).
 * Басқалар (QR сканерлеген клиенттер, Claude-қа кірмесе де) → талон беті және табло.
 */
import { h, mount } from '../public/assets/js/core/dom.js';
import { icon } from '../public/assets/js/core/icons.js';
import { onLangChange, t } from '../public/assets/js/core/i18n.js';
import { setTimeZone, todayKey } from '../public/assets/js/core/format.js';
import { emptyState, spinner } from '../public/assets/js/core/ui.js';
import { ADMIN_NAV, createAdminApp } from '../public/assets/js/admin/app.js';
import { CLIENT_ROUTES, createClientApp } from '../public/assets/js/client/app.js';
import { createRouter } from './router.js';
import { ready, runtime } from './runtime.js';
import { data, startStore } from './store.js';
import { embeddedSnapshot, publishChip } from './publisher.js';

const root = document.getElementById('app');

async function boot() {
  mount(root, spinner());
  setTimeZone(embeddedSnapshot()?.tz || 'Asia/Almaty');
  await ready;

  // Иесі ашты, бірақ деректер базасы қосылмады — клиент бетін емес, түсінікті хабар көрсетеміз
  if (runtime.isAdmin && runtime.db === null) {
    mount(
      root,
      h(
        'div',
        { class: 'client' },
        h(
          'div',
          { class: 'card' },
          emptyState({
            iconName: 'alert',
            title: t('error_network'),
            text: t('no_db'),
            action: h('button', { class: 'btn btn-soft', onclick: () => location.reload() }, icon('refresh'), t('refresh')),
          }),
        ),
      ),
    );
    return;
  }

  const isAdmin = runtime.isAdmin && runtime.db !== null;
  if (isAdmin) {
    await startStore({ today: () => todayKey() });
    if (data.settings.timeZone) setTimeZone(data.settings.timeZone);
  }

  const routes = [
    ...ADMIN_NAV.map((item) => ({ path: item.path, kind: 'admin', item })),
    ...CLIENT_ROUTES.map((route) => ({ ...route, kind: 'client' })),
  ];
  const adminApp = isAdmin
    ? createAdminApp({ root, withAuth: false, navigate: (path, opts) => router.navigate(path, opts), extraChrome: publishChip })
    : null;
  const clientApp = createClientApp({ root });
  let active = null;

  async function activate(kind) {
    if (active === kind) return;
    if (active === 'admin') adminApp.stop();
    if (active === 'client') clientApp.stop();
    active = kind;
    await (kind === 'admin' ? adminApp.start() : clientApp.start());
  }

  const router = createRouter(routes, async ({ route, params }) => {
    let target = route;
    if (adminApp && route.path === '/') target = routes[0]; // иесі үшін басты бет — касса
    if (target.kind === 'admin' && !adminApp) target = routes.find((r) => r.kind === 'client' && r.path === '/');
    if (target.kind === 'admin') {
      adminApp.show(target.item);
      await activate('admin');
    } else {
      clientApp.show(target, params);
      await activate('client');
    }
  });

  onLangChange(() => (active === 'admin' ? adminApp.rerender() : clientApp.rerender()));
  router.resolve();
}

boot();
