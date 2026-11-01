import { h, mount } from '../core/dom.js';
import { onLangChange, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { setTimeZone } from '../core/format.js';
import { connectLive } from '../core/live.js';
import { createRouter } from '../core/router.js';
import { registerServiceWorker } from '../core/pwa.js';
import { emptyState } from '../core/ui.js';
import { clientHeader } from './common.js';
import { homePage } from './home.js';
import { ticketPage } from './ticket.js';
import { boardPage } from './board.js';

const root = document.getElementById('app');
const info = { businessName: 'Astral', timeZone: 'Asia/Almaty' };
let current = null;
let online = true;

function notFoundPage() {
  return {
    el: h(
      'div',
      { class: 'client' },
      clientHeader(info),
      h('div', { class: 'card' }, emptyState({ iconName: 'alert', title: t('page_not_found'), action: h('a', { class: 'btn btn-soft', href: '/', 'data-link': true }, t('go_home')) })),
    ),
  };
}

const router = createRouter(
  [
    { path: '/', page: homePage, title: () => info.businessName },
    { path: '/t/:code', page: ticketPage, title: () => `${t('your_number')} · ${info.businessName}` },
    { path: '/board', page: boardPage, title: () => `${t('queue_board')} · ${info.businessName}` },
    { path: '*', page: notFoundPage, title: () => t('page_not_found') },
  ],
  ({ route, params }) => {
    current?.destroy?.();
    document.title = route.title();
    current = route.page({ params, info });
    current.setOnline?.(online);
    mount(root, current.el);
  },
);

async function loadInfo() {
  try {
    Object.assign(info, await api('/public/info'));
    setTimeZone(info.timeZone);
  } catch {
    /* әдепкі атау қалады */
  }
}

onLangChange(() => router.resolve());

async function boot() {
  registerServiceWorker();
  await loadInfo();
  router.resolve();
  connectLive(
    async (type) => {
      if (type === 'settings') {
        await loadInfo();
        router.resolve();
        return;
      }
      current?.onEvent?.(type);
    },
    {
      onStatus: (value) => {
        online = value;
        current?.setOnline?.(value);
      },
    },
  );
}

boot();
