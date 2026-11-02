import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dayLabel, itemsSummary, money, num, paymentTotals, time, todayKey } from '../core/format.js';
import { emptyState, spinner, statusChip, toast } from '../core/ui.js';
import { dateNav, pageHead, paymentBreakdown, paymentLabel, showOrderModal, typesTable } from '../admin/shared.js';

/**
 * Сатылым (кассирге): бір күнде қай билет қанша сатылды, қанша ақша түсті және қандай төлеммен —
 * кассадағы қолма-қол ақшаны (Наличка) және аударымдарды (Каспий, Банк) салыстыру үшін.
 * Төменде сол күнгі талондар: басса — QR қайта ашылады.
 */
export function salesPage() {
  const today = todayKey();
  let day = today;
  let data = null;
  let requestId = 0;

  const el = h('div', { class: 'page' });
  const filters = h('div', { class: 'filters' });
  const content = h('div', { class: 'stack' }, spinner());
  mount(el, pageHead(t('sales_title'), t('sales_lead')), filters, content);

  const dayText = () => (day === today ? `${t('today')}, ${dayLabel(day, { year: false })}` : dayLabel(day));

  async function load() {
    const id = ++requestId;
    content.classList.add('loading-dim');
    try {
      const result = await api(`/kassa/summary?date=${day}`);
      if (id !== requestId) return;
      data = result;
      renderContent();
    } catch (err) {
      if (err.status !== 401) toast(errorText(err), 'error');
    } finally {
      if (id === requestId) content.classList.remove('loading-dim');
    }
  }

  function setDay(value) {
    day = value > today ? today : value;
    renderFilters();
    load();
  }

  function renderFilters() {
    mount(
      filters,
      dateNav({ type: 'date', value: day, max: today, onChange: setDay }),
      day !== today && h('button', { class: 'btn btn-ghost btn-sm', onclick: () => setDay(today) }, t('today')),
    );
  }

  function kpis() {
    const { totals } = data;
    const tile = (cls, iconName, label, value, sub) =>
      h(
        'div',
        { class: ['card kpi', cls] },
        h('div', { class: 'kpi-label' }, icon(iconName), label),
        h('div', { class: 'kpi-value' }, value),
        sub && h('div', { class: 'kpi-sub' }, sub),
      );
    return h(
      'div',
      { class: 'kpis kpis-3' },
      tile('hero', 'wallet', t('revenue'), money(totals.revenue), dayText()),
      tile('', 'ticket', t('tickets_sold'), num(totals.people), t('people_unit')),
      tile('', 'users', t('orders_count'), num(totals.orders), totals.cancelled ? t('cancelled_note', { n: totals.cancelled }) : null),
    );
  }

  function orderRow(order) {
    const open = () => showOrderModal(order, { onChanged: load });
    const pays = paymentTotals(order.items);
    return h(
      'div',
      { class: 'list-item', onclick: open, role: 'button', tabindex: '0', onkeydown: (e) => e.key === 'Enter' && open() },
      h('div', { class: 'qnum' }, String(order.number)),
      h(
        'div',
        { class: 'qbody' },
        h('div', { class: 'qitems' }, itemsSummary(order.items)),
        h(
          'div',
          { class: 'qmeta' },
          h('span', null, icon('clock', 'icon icon-sm'), time(order.createdAt)),
          pays.map((p) => h('span', { class: 'pay-tag' }, paymentLabel(p.name))),
          h('span', { class: 'num' }, money(order.total)),
        ),
      ),
      order.status === 'cancelled' || order.status === 'serving' ? statusChip(order.status) : icon('qr', 'icon faint'),
    );
  }

  function renderContent() {
    if (!data) return;
    const hasSales = data.totals.orders > 0;
    mount(
      content,
      kpis(),
      h(
        'div',
        { class: 'report-grid' },
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'card-head' }, icon('wallet'), h('div', { style: { flex: '1' } }, h('h2', null, t('by_payment')), h('div', { class: 'sub' }, dayText()))),
          h(
            'div',
            { class: 'card-body' },
            data.byPayment?.length ? paymentBreakdown(data.byPayment, data.totals.revenue) : emptyState({ iconName: 'wallet', title: t('no_sales') }),
          ),
        ),
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'card-head' }, icon('tag'), h('div', { style: { flex: '1' } }, h('h2', null, t('by_types')), h('div', { class: 'sub' }, dayText()))),
          data.byType.length ? typesTable(data.byType, data.totals, { share: false }) : h('div', { class: 'card-body' }, emptyState({ iconName: 'tag', title: t('no_sales') })),
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, icon('receipt'), h('h2', null, t('sales_orders')), h('span', { class: 'sub' }, String(data.orders.length))),
        hasSales || data.orders.length
          ? h('div', { class: 'card-body', style: { padding: '8px 0 4px' } }, h('div', { class: 'list' }, data.orders.map(orderRow)))
          : h('div', { class: 'card-body' }, emptyState({ iconName: 'receipt', title: t('no_sales') })),
      ),
    );
  }

  renderFilters();
  load();

  return {
    el,
    onEvent(type) {
      if (day === today && (type === 'queue' || type === 'resync' || type === 'types')) load();
    },
  };
}
