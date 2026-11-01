import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { setTimeZone } from '../core/format.js';
import { connectLive } from '../core/live.js';
import { registerServiceWorker } from '../core/pwa.js';
import { emptyState } from '../core/ui.js';
import { clientHeader } from './common.js';
import { homePage } from './home.js';
import { ticketPage } from './ticket.js';
import { boardPage } from './board.js';

const info = { businessName: 'Astral', timeZone: 'Asia/Almaty' };

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

export const CLIENT_ROUTES = [
  { path: '/', page: homePage, title: () => info.businessName },
  { path: '/t/:code', page: ticketPage, title: () => `${t('your_number')} · ${info.businessName}` },
  { path: '/board', page: boardPage, title: () => `${t('queue_board')} · ${info.businessName}` },
  { path: '*', page: notFoundPage, title: () => t('page_not_found') },
];

/**
 * Клиент қосымшасы: басты бет, талон, табло. Маршрутизатор сырттан беріледі.
 * @param {{ root: HTMLElement }} options
 */
export function createClientApp({ root }) {
  let current = null;
  let wanted = null;
  let online = true;
  let started = false;
  let stopLive = null;

  async function loadInfo() {
    try {
      Object.assign(info, await api('/public/info'));
      setTimeZone(info.timeZone);
    } catch {
      /* әдепкі атау қалады */
    }
  }

  function render() {
    if (!wanted) return;
    const { route, params } = wanted;
    current?.destroy?.();
    document.title = route.title();
    current = route.page({ params, info });
    current.setOnline?.(online);
    mount(root, current.el);
  }

  return {
    async start() {
      registerServiceWorker();
      await loadInfo();
      started = true;
      render();
      stopLive = connectLive(
        async (type) => {
          if (type === 'settings') {
            await loadInfo();
            render();
            return;
          }
          current?.onEvent?.(type);
        },
        {
          mode: info.realtime,
          onStatus: (value) => {
            online = value;
            current?.setOnline?.(value);
          },
        },
      );
    },

    show(route, params) {
      wanted = { route, params };
      if (started) render();
    },

    rerender: render,

    stop() {
      stopLive?.();
      stopLive = null;
      started = false;
      current?.destroy?.();
      current = null;
    },
  };
}
