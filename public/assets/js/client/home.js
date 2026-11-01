import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dateTime, todayKey } from '../core/format.js';
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from '../core/pwa.js';
import { statusChip } from '../core/ui.js';
import { env } from '../core/env.js';
import { LOGO_URL } from '../core/logo.js';
import { clientHeader } from './common.js';
import { forgetTicket, savedTickets } from './saved.js';

/** Клиенттің басты беті: сақталған талондар, QR сканерлеу нұсқаулығы, қосымшаны орнату. */
export function homePage({ info }) {
  const el = h('div', { class: 'client' });
  const statuses = new Map();

  async function refreshStatuses() {
    const list = savedTickets().slice(0, 6);
    await Promise.all(
      list.map(async (ticket) => {
        try {
          const res = await api(`/public/orders/${encodeURIComponent(ticket.code)}`);
          statuses.set(ticket.code, res.order.status);
        } catch (err) {
          if (err.status === 404) forgetTicket(ticket.code);
        }
      }),
    );
    render();
  }

  function savedCard() {
    const today = todayKey();
    const list = savedTickets().slice(0, 6);
    if (!list.length) return null;
    return h(
      'section',
      { class: 'card saved-list' },
      h('div', { class: 'card-head' }, h('h2', null, t('my_tickets'))),
      h(
        'div',
        { class: 'list', style: { padding: '10px 0 6px' } },
        list.map((ticket, index) => {
          const status = statuses.get(ticket.code);
          return h(
            'a',
            { class: 'list-item', href: `/t/${ticket.code}`, 'data-link': true, style: { color: 'inherit', textDecoration: 'none' } },
            h('div', { class: ['qnum', index === 0 && ticket.day === today && 'first'] }, String(ticket.number)),
            h('div', { class: 'qbody' }, h('div', { class: 'qitems' }, `№${ticket.number}`), h('div', { class: 'qmeta' }, dateTime(ticket.createdAt))),
            status ? statusChip(status) : icon('chevronRight', 'icon faint'),
          );
        }),
      ),
    );
  }

  function installCard() {
    if (env.artifact || isStandalone()) return null;
    if (canPromptInstall()) {
      return h(
        'section',
        { class: 'card install-card' },
        h('img', { class: 'brand-logo', src: LOGO_URL, alt: '' }),
        h('div', { class: 'qbody' }, h('div', { style: { fontWeight: '700' } }, t('install_app')), h('div', { class: 'qmeta' }, t('install_hint'))),
        h('button', { class: 'btn btn-soft btn-sm', onclick: () => promptInstall() }, icon('download', 'icon icon-sm'), t('install')),
      );
    }
    if (isIos()) {
      return h(
        'section',
        { class: 'card install-card' },
        h('img', { class: 'brand-logo', src: LOGO_URL, alt: '' }),
        h('div', { class: 'qbody' }, h('div', { style: { fontWeight: '700' } }, t('install_app')), h('div', { class: 'qmeta' }, t('ios_install_hint'))),
      );
    }
    return null;
  }

  function render() {
    mount(
      el,
      clientHeader(info),
      savedCard(),
      h(
        'section',
        { class: 'card hero-scan' },
        h('div', { class: 'scan-art' }, icon('scan')),
        h('h1', null, t('scan_title')),
        h('p', null, t('scan_text')),
      ),
      installCard(),
      h(
        'a',
        { class: 'card install-card', href: '/board', 'data-link': true, style: { color: 'inherit', textDecoration: 'none' } },
        h('div', { class: 'empty-icon', style: { width: '44px', height: '44px', borderRadius: '14px' } }, icon('monitor')),
        h('div', { class: 'qbody' }, h('div', { style: { fontWeight: '700' } }, t('queue_board'))),
        icon('chevronRight', 'icon faint'),
      ),
    );
  }

  render();
  refreshStatuses();
  const unsubscribe = onInstallChange(render);

  return {
    el,
    onEvent(type) {
      if (type === 'queue') refreshStatuses();
    },
    destroy: unsubscribe,
  };
}
