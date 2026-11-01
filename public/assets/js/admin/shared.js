import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dateTime, money } from '../core/format.js';
import { qrSvg } from '../core/qr.js';
import { printTicket } from '../core/media.js';
import { copyText, openModal, statusChip, toast, withBusy, confirmDialog } from '../core/ui.js';
import { env } from '../core/env.js';

/** Әкімші қосымшасының ортақ күйі. */
export const store = {
  info: { businessName: 'Astral', timeZone: 'Asia/Almaty' },
  passwordIsDefault: false,
  /** Сервердің жергілікті желідегі мекенжайлары (http://192.168.x.x:3000) */
  lanUrls: [],
  /** Кассадағы таңдау: ticketTypeId → саны (тіл ауысқанда да сақталады) */
  cart: new Map(),
};

/** QR ішіндегі сілтеме: PUBLIC_URL берілсе — сол, әйтпесе браузердегі мекенжай. */
export const orderUrl = (order) =>
  env.artifact
    ? `${store.info.publicUrl || ''}#t-${order.code}` // Claude сілтемесінде тек #атау беріледі
    : `${store.info.publicUrl || location.origin}/t/${order.code}`;

const isLocalHost = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** Әкімші бетін localhost арқылы ашса, QR клиент телефонында ашылмайды — ескертеміз. */
function localhostNotice() {
  if (env.artifact && !store.info.publicUrl) {
    return h(
      'a',
      { class: 'notice', href: '/admin/settings', 'data-link': true, style: { width: '100%', textAlign: 'left', textDecoration: 'none' } },
      icon('alert'),
      h('span', null, t('public_link_missing')),
    );
  }
  if (env.artifact || store.info.publicUrl || !isLocalHost()) return null;
  const lan = store.lanUrls[0];
  return h(
    'div',
    { class: 'notice', style: { width: '100%', textAlign: 'left' } },
    icon('alert'),
    h('span', null, t('localhost_warning'), lan ? [': ', h('b', null, `${lan}/admin`)] : '.'),
  );
}

export function pageHead(title, lead, ...actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', null, title), lead && h('p', null, lead)),
    actions.length ? h('div', { class: 'row wrap' }, actions) : null,
  );
}

/** Билеттер тізімі: түс белгісі, атауы × саны, сомасы және жалпы қорытынды. */
export function itemsBlock(order) {
  return h(
    'div',
    { class: 'items-list' },
    order.items.map((item) =>
      h(
        'div',
        { class: 'item-row' },
        h('span', { class: 'dot', style: { '--dot': item.color == null ? 'var(--text-3)' : `var(--c${item.color})` } }),
        h('span', { class: 'name' }, item.name),
        h('span', { class: 'qty' }, `×${item.qty}`),
        h('span', { class: 'sum' }, money(item.qty * item.price)),
      ),
    ),
    h(
      'div',
      { class: 'items-total' },
      h('span', null, `${t('total')} · ${t('people_count', { n: order.people })}`),
      h('span', { class: 'sum' }, money(order.total)),
    ),
  );
}

/**
 * Талон терезесі: нөмір, QR, билеттер. «issued» — жаңа берілген талон, «details» — кезектегі талон.
 * @param {object} order
 * @param {{ mode?: 'issued' | 'details', onChanged?: () => void }} [options]
 */
export function showOrderModal(order, { mode = 'details', onChanged } = {}) {
  const url = orderUrl(order);
  const isIssued = mode === 'issued';

  const setStatus = async (button, status, confirmText) => {
    if (confirmText) {
      const ok = await confirmDialog({ title: t('order_title', { n: order.number }), message: confirmText, danger: true, confirmText: t('cancel_order') });
      if (!ok) return;
    }
    await withBusy(button, async () => {
      try {
        await api(`/admin/orders/${order.id}`, { method: 'PATCH', body: { status } });
        modal.close();
        if (status === 'serving') toast(t('called_toast', { n: order.number }));
        onChanged?.();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });
  };

  const actionButtons = [];
  if (!isIssued) {
    if (order.status === 'waiting') {
      actionButtons.push(
        h('button', { class: 'btn btn-primary', onclick: (e) => setStatus(e.currentTarget, 'serving') }, icon('megaphone'), t('call')),
      );
    }
    if (order.status === 'serving') {
      actionButtons.push(
        h('button', { class: 'btn btn-success', onclick: (e) => setStatus(e.currentTarget, 'done') }, icon('check'), t('finish')),
        h('button', { class: 'btn btn-soft', onclick: (e) => setStatus(e.currentTarget, 'serving') }, icon('megaphone'), t('recall')),
      );
    }
    if (order.status !== 'waiting') {
      actionButtons.push(
        h('button', { class: 'btn btn-ghost', onclick: (e) => setStatus(e.currentTarget, 'waiting') }, icon('undo'), t('return_to_queue')),
      );
    }
    if (order.status === 'waiting' || order.status === 'serving') {
      actionButtons.push(
        h(
          'button',
          { class: 'btn btn-danger', onclick: (e) => setStatus(e.currentTarget, 'cancelled', t('cancel_order_confirm', { n: order.number })) },
          icon('x'),
          t('cancel_order'),
        ),
      );
    }
  }

  const body = h(
    'div',
    { class: 'issued' },
    h('div', { class: 'issued-label' }, t('queue_number')),
    h('div', { class: 'big-number' }, h('span', { class: 'hash' }, '№'), String(order.number)),
    !isIssued && statusChip(order.status),
    localhostNotice(),
    h('div', { class: 'qr-box' }, qrSvg(url, { label: `QR №${order.number}` })),
    h('p', { class: 'muted small' }, t('scan_hint')),
    itemsBlock(order),
    !isIssued && h('p', { class: 'faint small' }, `${t('issued_at')}: ${dateTime(order.createdAt)}`),
    h(
      'div',
      { class: 'row', style: { width: '100%' } },
      // Claude сілтемесінде басып шығару (window.print) рұқсат етілмейді
      !env.artifact &&
        h(
          'button',
          { class: 'btn btn-soft', style: { flex: '1' }, onclick: () => printTicket({ businessName: store.info.businessName, order, url }) },
          icon('printer'),
          t('print'),
        ),
      h(
        'button',
        {
          class: 'btn btn-soft',
          style: { flex: '1' },
          onclick: async () => {
            if (await copyText(url)) toast(t('link_copied'));
          },
        },
        icon('link'),
        t('copy_link'),
      ),
    ),
    actionButtons.length ? h('div', { class: 'stack', style: { width: '100%', gap: '10px' } }, actionButtons) : null,
  );

  const modal = openModal({
    title: isIssued ? t('ticket_ready') : t('order_title', { n: order.number }),
    body,
    footer: isIssued
      ? h('button', { class: 'btn btn-primary btn-lg btn-block', autofocus: true, onclick: () => modal.close() }, icon('check'), t('next_client'))
      : null,
  });
  return modal;
}
