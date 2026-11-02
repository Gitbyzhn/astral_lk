import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dateTime, dayLabel, money, monthLabel, num, paymentTotals } from '../core/format.js';
import { qrSvg } from '../core/qr.js';
import { printTicket } from '../core/media.js';
import { copyText, openModal, statusChip, toast, withBusy, confirmDialog } from '../core/ui.js';
import { env } from '../core/env.js';

/** Қызметкер қосымшасының (әкімші / касса) ортақ күйі. */
export const store = {
  info: { businessName: 'Astral Labyrinth', timeZone: 'Asia/Almaty' },
  /** 'admin' — әкімші, 'cashier' — касса сілтемесімен кірген кассир */
  role: 'admin',
  passwordIsDefault: false,
  /** Сервердің жергілікті желідегі мекенжайлары (http://192.168.x.x:3000) */
  lanUrls: [],
  /** Кассадағы таңдау: ticketTypeId → саны (тіл ауысқанда да сақталады) */
  cart: new Map(),
  /** Бүкіл тапсырыстың төлем түрі (null — әдепкісі, мысалы Каспий) */
  payment: null,
  /** Әр билеттің жеке төлем түрі: ticketTypeId → [1-билет, 2-билет, …] (бос орын — тапсырыстікі) */
  unitPay: new Map(),
};

/**
 * Төлем түрінің түсі (тек есептегі бөліну жолағында): id бойынша тұрақты — біреуі жойылса да басқалардың
 * түсі өзгермейді. Палитра соңынан алынады, сонда алғашқы билет түрлерінің түстерімен (c0, c1, c2…) шатаспайды.
 */
export const paymentColor = (id) => (id == null ? 'var(--text-3)' : `var(--c${7 - ((Number(id) - 1) % 8)})`);

/** Төлем түрінің атауы (ескі тапсырыстарда жоқ — «Көрсетілмеген»). */
export const paymentLabel = (name) => name ?? t('payment_unknown');

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

/** Билеттер тізімі: түс белгісі, атауы, төлем түрі, саны, сомасы және жалпы қорытынды. */
export function itemsBlock(order) {
  const payments = paymentTotals(order.items);
  const mixed = payments.length > 1;
  return h(
    'div',
    { class: 'items-list' },
    order.items.map((item) =>
      h(
        'div',
        { class: 'item-row' },
        h('span', { class: 'dot', style: { '--dot': item.color == null ? 'var(--text-3)' : `var(--c${item.color})` } }),
        h(
          'span',
          { class: 'name' },
          item.name,
          item.paymentName && h('span', { class: 'pay-tag' }, item.paymentName),
        ),
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
    // Бір топ әртүрлі төлесе — қай түрмен қанша алу керегі
    mixed &&
      h(
        'div',
        { class: 'pay-split' },
        payments.map((p) => h('span', null, `${paymentLabel(p.name)} `, h('b', null, money(p.sum)))),
      ),
  );
}

/**
 * Күн немесе ай таңдағыш: ‹ [күнтізбе] › — есеп пен сатылым беттеріне ортақ.
 * @param {{ type: 'date' | 'month', value: string, max: string, onChange: (value: string) => void }} options
 */
export function dateNav({ type, value, max, onChange }) {
  const isDay = type === 'date';
  const shift = (delta) => {
    if (isDay) {
      const d = new Date(`${value}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    }
    const [y, m] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
  };
  const picker = h('input', {
    type,
    value,
    max,
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (e) => {
      const v = e.target.value;
      if (v) onChange(v > max ? max : v);
    },
  });
  return h(
    'div',
    { class: 'datenav' },
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '‹', onclick: () => onChange(shift(-1)) }, icon('chevronLeft')),
    h(
      'label',
      {
        onclick: (e) => {
          e.preventDefault();
          try {
            picker.showPicker();
          } catch {
            picker.focus();
          }
        },
      },
      icon('calendar', 'icon icon-sm'),
      h('span', null, isDay ? dayLabel(value) : monthLabel(value)),
      picker,
    ),
    h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '›', disabled: value >= max, onclick: () => onChange(shift(1)) }, icon('chevronRight')),
  );
}

/**
 * Төлем түрлері бойынша бөліну: жіңішке бөлікті жолақ (бүтіннің үлестері) және әр түрдің сомасы.
 * Кассадағы ақшаны (Наличка) және аударымдарды (Каспий, Банк) салыстыру үшін.
 * @param {{ id: number | null, name: string | null, deleted?: boolean, qty: number, revenue: number }[]} rows
 * @param {number} total
 */
export function paymentBreakdown(rows, total) {
  const visible = rows.filter((row) => row.revenue > 0 || (!row.deleted && row.id !== null));
  const share = (row) => (total ? (row.revenue / total) * 100 : 0);
  const pct = (row) => {
    const value = share(row);
    return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
  };
  const parts = visible.filter((row) => row.revenue > 0);
  return h(
    'div',
    { class: 'pay-breakdown' },
    parts.length > 0 &&
      h(
        'div',
        {
          class: 'seg-bar',
          role: 'img',
          'aria-label': parts.map((row) => `${paymentLabel(row.name)}: ${money(row.revenue)} (${pct(row)})`).join(', '),
        },
        parts.map((row) =>
          h('span', {
            style: { flexGrow: String(row.revenue), '--dot': paymentColor(row.deleted ? null : row.id) },
            title: `${paymentLabel(row.name)} · ${money(row.revenue)} · ${pct(row)}`,
          }),
        ),
      ),
    h(
      'div',
      { class: 'pay-rows' },
      visible.map((row) =>
        h(
          'div',
          { class: ['pay-row', row.revenue === 0 && 'zero'] },
          h('span', { class: 'dot', style: { '--dot': paymentColor(row.deleted ? null : row.id) } }),
          h(
            'div',
            { class: 'pay-name' },
            h('span', null, paymentLabel(row.name), row.deleted && h('small', null, ` · ${t('deleted_type')}`)),
            h('span', { class: 'pay-meta' }, `${t('tickets_count', { n: row.qty })} · ${pct(row)}`),
          ),
          h('span', { class: 'pay-sum' }, money(row.revenue)),
        ),
      ),
    ),
  );
}

/**
 * Билет түрлері бойынша кесте: түр, саны, сомасы, үлесі (есеп пен сатылым беттеріне ортақ).
 * @param {{ share?: boolean }} [options]  share: false — тар бағанда «үлес» бағаны жасырылады
 */
export function typesTable(rows, totals, { share: withShare = true } = {}) {
  const total = totals.revenue;
  return h(
    'div',
    { class: 'table-wrap', style: { padding: '8px 0 6px' } },
    h(
      'table',
      { class: 'table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, t('col_type')), h('th', { class: 'r' }, t('col_qty')), h('th', { class: 'r' }, t('col_sum')), withShare && h('th', { class: 'hide-sm' }, t('col_share'))),
      ),
      h(
        'tbody',
        null,
        rows.map((row) => {
          const share = total ? (row.revenue / total) * 100 : 0;
          return h(
            'tr',
            null,
            h(
              'td',
              null,
              h(
                'div',
                { class: 't-name' },
                h('span', { class: 'dot', style: { '--dot': row.color == null ? 'var(--text-3)' : `var(--c${row.color})` } }),
                h('span', null, row.name, row.deleted && h('small', null, ` · ${t('deleted_type')}`)),
              ),
            ),
            h('td', { class: 'r' }, num(row.qty)),
            h('td', { class: 'r' }, money(row.revenue)),
            withShare &&
              h(
                'td',
                { class: 'hide-sm' },
                h(
                  'div',
                  { class: 'share' },
                  h('div', { class: 'share-track' }, h('div', { class: 'share-fill', style: { width: `${share}%` } })),
                  h('span', null, `${Math.round(share)}%`),
                ),
              ),
          );
        }),
      ),
      h(
        'tfoot',
        null,
        h('tr', null, h('td', null, t('total')), h('td', { class: 'r' }, num(totals.people)), h('td', { class: 'r' }, money(total)), withShare && h('td', { class: 'hide-sm' })),
      ),
    ),
  );
}

/**
 * Талон терезесі: нөмір, QR, билеттер. «issued» — жаңа берілген талон, «details» — кезектегі талон
 * (шақыру, қайта шақыру, кезекке қайтару — әкімші мен кассирге).
 * @param {object} order
 * @param {{ mode?: 'issued' | 'details', onChanged?: () => void, actions?: boolean }} [options]
 */
export function showOrderModal(order, { mode = 'details', onChanged, actions = true } = {}) {
  const url = orderUrl(order);
  const isIssued = mode === 'issued';

  const setStatus = async (button, status, confirmText) => {
    if (confirmText) {
      const ok = await confirmDialog({ title: t('order_title', { n: order.number }), message: confirmText, danger: true, confirmText: t('cancel_order') });
      if (!ok) return;
    }
    await withBusy(button, async () => {
      try {
        await api(`/kassa/orders/${order.id}`, { method: 'PATCH', body: { status } });
        modal.close();
        if (status === 'serving') toast(t('called_toast', { n: order.number }));
        if (status === 'cancelled') toast(t('cancelled_toast', { n: order.number }));
        onChanged?.();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });
  };

  const actionButtons = [];
  if (!isIssued && actions) {
    if (order.status === 'waiting') {
      actionButtons.push(
        h('button', { class: 'btn btn-primary', onclick: (e) => setStatus(e.currentTarget, 'serving') }, icon('megaphone'), t('call')),
      );
    }
    if (order.status === 'serving') {
      actionButtons.push(h('button', { class: 'btn btn-soft', onclick: (e) => setStatus(e.currentTarget, 'serving') }, icon('megaphone'), t('recall')));
    }
    if (order.status !== 'waiting') {
      actionButtons.push(
        h('button', { class: 'btn btn-ghost', onclick: (e) => setStatus(e.currentTarget, 'waiting') }, icon('undo'), t('return_to_queue')),
      );
    }
    // «Қате билет» мұнда жоқ — тізімдегі 🗑 түймесімен және шақырылған топтың карточкасында
  }

  const body = h(
    'div',
    { class: 'issued' },
    h('div', { class: 'issued-label' }, t('queue_number')),
    h('div', { class: 'big-number' }, h('span', { class: 'hash' }, '№'), String(order.number)),
    !isIssued && statusChip(order.status),
    // Кезектегі талон: әрекеттер QR-дан жоғары — «Қате билет» бірден көрінсін
    actionButtons.length ? h('div', { class: 'order-actions' }, actionButtons) : null,
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
