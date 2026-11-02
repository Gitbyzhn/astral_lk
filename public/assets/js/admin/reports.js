import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dateTime, dayLabel, itemsSummary, money, monthLabel, num, paymentTotals, todayKey } from '../core/format.js';
import { confirmDialog, emptyState, openModal, spinner, statusChip, toast, withBusy } from '../core/ui.js';
import { env } from '../core/env.js';
import { dateNav, pageHead, paymentBreakdown, paymentLabel, typesTable } from './shared.js';
import { columnChart } from './chart.js';

// Сүзгі күйі беттер арасында ауысқанда сақталады.
const state = { period: 'day', day: null, month: null, view: 'chart' };

/** Есеп: күндік / айлық / жалпы. Карточкалар, төлем түрлері, түсім графигі және билет түрлері бойынша кесте. */
export function reportsPage() {
  const today = todayKey();
  state.day ??= today;
  state.month ??= today.slice(0, 7);

  const el = h('div', { class: 'page' });
  const filters = h('div', { class: 'filters' });
  const content = h('div', { class: 'stack' }, spinner());
  let report = null;
  let requestId = 0;

  mount(el, pageHead(t('reports'), t('reports_lead')), filters, content);

  async function load() {
    const id = ++requestId;
    const date = state.period === 'day' ? state.day : state.period === 'month' ? state.month : '';
    content.classList.add('loading-dim');
    try {
      const data = await api(`/admin/reports?period=${state.period}${date ? `&date=${date}` : ''}`);
      if (id !== requestId) return;
      report = data;
      renderContent();
    } catch (err) {
      if (err.status !== 401) toast(errorText(err), 'error');
    } finally {
      if (id === requestId) content.classList.remove('loading-dim');
    }
  }

  function setPeriod(period) {
    state.period = period;
    renderFilters();
    load();
  }

  function periodLabel() {
    if (state.period === 'day') return state.day === today ? `${t('today')}, ${dayLabel(state.day, { year: false })}` : dayLabel(state.day);
    if (state.period === 'month') return monthLabel(state.month);
    return t('all_time');
  }

  function renderFilters() {
    const seg = h(
      'div',
      { class: 'seg', role: 'group' },
      ['day', 'month', 'all'].map((p) =>
        h('button', { type: 'button', 'aria-pressed': String(state.period === p), onclick: () => setPeriod(p) }, t(`period_${p}`)),
      ),
    );

    let nav = null;
    if (state.period !== 'all') {
      const isDay = state.period === 'day';
      nav = dateNav({
        type: isDay ? 'date' : 'month',
        value: isDay ? state.day : state.month,
        max: isDay ? today : today.slice(0, 7),
        onChange: (value) => {
          if (isDay) state.day = value;
          else state.month = value;
          renderFilters();
          load();
        },
      });
    }

    const todayBtn =
      state.period === 'day' && state.day !== today
        ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => ((state.day = today), renderFilters(), load()) }, t('today'))
        : null;

    mount(filters, seg, nav, todayBtn);
  }

  /* ------------------------------ Карточкалар ------------------------------ */
  const dateParam = () => (state.period === 'day' ? state.day : state.period === 'month' ? state.month : '');

  function kpis() {
    const { totals } = report;
    const tile = (cls, iconName, label, value, sub) =>
      h(
        'div',
        { class: ['card kpi', cls] },
        h('div', { class: 'kpi-label' }, icon(iconName), label),
        h('div', { class: 'kpi-value' }, value),
        sub && h('div', { class: 'kpi-sub' }, sub),
      );
    // «Сатылған билет» — басса, кезеңдегі талондар тізімі ашылады (таңдап өшіру — есепті тазалау)
    const soldTile = env.artifact
      ? tile('', 'ticket', t('tickets_sold'), num(totals.people), t('people_unit'))
      : h(
          'button',
          { class: 'card kpi kpi-action', type: 'button', 'aria-haspopup': 'dialog', onclick: openSoldList },
          h('div', { class: 'kpi-label' }, icon('ticket'), t('tickets_sold'), icon('chevronRight', 'icon kpi-go')),
          h('div', { class: 'kpi-value' }, num(totals.people)),
          h('div', { class: 'kpi-sub' }, `${t('people_unit')} · `, h('span', { class: 'kpi-link' }, t('sold_list_hint'))),
        );
    return h(
      'div',
      { class: 'kpis' },
      tile('hero', 'wallet', t('revenue'), money(totals.revenue), periodLabel()),
      soldTile,
      tile('', 'users', t('orders_count'), num(totals.orders), totals.cancelled ? t('cancelled_note', { n: totals.cancelled }) : null),
      tile('', 'receipt', t('avg_check'), money(totals.avgCheck), t('per_group')),
    );
  }

  /* ------------------- Сатылған билеттер: таңдап өшіру (тазалау) ------------------- */
  function openSoldList() {
    const period = state.period;
    const date = dateParam();
    const label = periodLabel();
    const selected = new Set();
    let list = null; // { total, orders }
    let allMode = false; // «Барлығын таңдау»

    const body = h('div', { class: 'sold' }, spinner());
    const delBtn = h('button', { class: 'btn btn-danger', disabled: true, onclick: (e) => remove(e.currentTarget) }, icon('trash'), t('delete'));
    const modal = openModal({
      title: `${t('sold_list')} · ${label}`,
      body,
      wide: true,
      footer: [h('button', { class: 'btn btn-ghost', onclick: () => modal.close() }, t('close')), delBtn],
    });

    const truncated = () => list.total > list.orders.length;
    const count = () => (allMode ? list.total : selected.size);

    function sync() {
      const n = count();
      delBtn.disabled = n === 0;
      mount(delBtn, icon('trash'), n ? `${t('delete')} · ${n}` : t('delete'));
      for (const box of body.querySelectorAll('input[data-id]')) box.checked = allMode || selected.has(Number(box.dataset.id));
      const all = body.querySelector('input[data-all]');
      if (all) {
        all.checked = allMode;
        all.indeterminate = !allMode && selected.size > 0;
      }
      const counter = body.querySelector('[data-counter]');
      if (counter) counter.textContent = t('selected_n', { n });
    }

    function toggle(id, on) {
      if (allMode) {
        // «Барлығы» таңдалғаннан кейін біреуін алып тастаса — көрінетін талондардың қалғаны таңдалады
        allMode = false;
        for (const order of list.orders) selected.add(order.id);
      }
      if (on) selected.add(id);
      else selected.delete(id);
      if (!truncated() && selected.size === list.orders.length && list.orders.length) {
        allMode = true;
        selected.clear();
      }
      sync();
    }

    function row(order) {
      const pays = paymentTotals(order.items).filter((p) => p.name);
      return h(
        'label',
        { class: ['sold-row', order.status === 'cancelled' && 'is-cancelled'] },
        h('input', { class: 'check', type: 'checkbox', 'data-id': String(order.id), onchange: (e) => toggle(order.id, e.target.checked) }),
        h('div', { class: 'qnum' }, String(order.number)),
        h(
          'div',
          { class: 'qbody' },
          h('div', { class: 'qitems' }, itemsSummary(order.items)),
          h(
            'div',
            { class: 'qmeta' },
            h('span', null, dateTime(order.createdAt)),
            pays.map((p) => h('span', { class: 'pay-tag' }, p.name)),
            order.status === 'cancelled' && statusChip('cancelled'),
          ),
        ),
        h('div', { class: 'sold-sum' }, money(order.total)),
      );
    }

    function draw() {
      if (!list.orders.length) {
        mount(body, emptyState({ iconName: 'ticket', title: t('no_orders') }));
        return;
      }
      mount(
        body,
        h(
          'div',
          { class: 'sold-tools' },
          h(
            'label',
            { class: 'sold-all' },
            h('input', {
              class: 'check',
              type: 'checkbox',
              'data-all': true,
              onchange: (e) => {
                allMode = e.target.checked;
                selected.clear();
                sync();
              },
            }),
            t('select_all'),
          ),
          h('span', { class: 'faint small' }, t('talon_count', { n: list.total })),
          h('span', { class: 'spacer' }),
          h('span', { class: 'small', 'data-counter': true }),
        ),
        truncated() && h('p', { class: 'hint' }, t('list_truncated', { shown: list.orders.length, n: list.total })),
        h('div', { class: 'sold-list' }, list.orders.map(row)),
      );
      sync();
    }

    async function fetchList() {
      try {
        list = await api(`/admin/report-orders?period=${period}${date ? `&date=${date}` : ''}`);
        selected.clear();
        allMode = false;
        draw();
      } catch (err) {
        toast(errorText(err), 'error');
        modal.close();
      }
    }

    async function remove(button) {
      const n = count();
      // Тізім толық болса — тек көрінген талондар (id бойынша); толық емес болса — бүкіл кезең
      const byRange = allMode && truncated();
      const ok = await confirmDialog({
        title: t('delete'),
        message: byRange ? t('delete_all_confirm', { n }) : t('delete_orders_confirm', { n }),
        confirmText: t('delete'),
        danger: true,
      });
      if (!ok) return;
      await withBusy(button, async () => {
        try {
          const ids = allMode ? list.orders.map((o) => o.id) : [...selected];
          const payload = byRange ? { all: true, period, ...(date && { date }) } : { ids };
          const { deleted } = await api('/admin/orders/delete', { method: 'POST', body: payload });
          toast(t('orders_deleted', { n: deleted }));
          await fetchList();
          load();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      });
    }

    fetchList();
  }

  /* -------------------------------- График -------------------------------- */
  function seriesForChart() {
    let series = report.series;
    if (report.group === 'hour') {
      const active = series.filter((p) => p.revenue > 0 || p.orders > 0).map((p) => Number(p.key));
      const from = Math.min(9, ...active);
      const to = Math.max(20, ...active);
      series = series.filter((p) => Number(p.key) >= from && Number(p.key) <= to);
    }
    return series;
  }

  const pointLabel = (key) => {
    if (report.group === 'hour') return String(key);
    if (report.group === 'day') return String(Number(key.slice(8)));
    const [y, m] = key.split('-').map(Number);
    return `${t('months_short')[m - 1]}${m === 1 ? ` ${String(y).slice(2)}` : ''}`;
  };

  const pointTitle = (key) => {
    if (report.group === 'hour') {
      const hh = String(key).padStart(2, '0');
      const next = String((Number(key) + 1) % 24).padStart(2, '0');
      return `${hh}:00 – ${next}:00`;
    }
    if (report.group === 'day') return dayLabel(key);
    return monthLabel(key);
  };

  function chartCard() {
    const series = seriesForChart();
    const hasData = report.totals.orders > 0;
    const title = t(`chart_${report.period}`);

    const viewSeg = h(
      'div',
      { class: 'seg', role: 'group' },
      [
        ['chart', 'chart', t('show_chart')],
        ['table', 'table', t('show_table')],
      ].map(([value, iconName, label]) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(state.view === value),
            'aria-label': label,
            title: label,
            onclick: () => {
              state.view = value;
              renderContent();
            },
          },
          icon(iconName, 'icon icon-sm'),
        ),
      ),
    );

    let body;
    if (!hasData) {
      body = emptyState({ iconName: 'chart', title: t('no_data') });
    } else if (state.view === 'table') {
      const rows = series.filter((p) => p.orders > 0);
      body = h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, t('col_period')), h('th', { class: 'r' }, t('col_sum')), h('th', { class: 'r' }, t('col_qty')), h('th', { class: 'r' }, t('col_orders')))),
          h(
            'tbody',
            null,
            rows.map((p) => h('tr', null, h('td', null, pointTitle(p.key)), h('td', { class: 'r' }, money(p.revenue)), h('td', { class: 'r' }, num(p.people)), h('td', { class: 'r' }, num(p.orders)))),
          ),
        ),
      );
    } else {
      const n = series.length;
      body = columnChart({
        points: series.map((p) => ({ ...p, value: p.revenue })),
        label: pointLabel,
        showLabel: (i) => {
          if (report.group === 'day') return i === 0 || (i + 1) % 5 === 0;
          if (n <= 14) return true;
          return i % Math.ceil(n / 12) === 0;
        },
        ariaLabel: title,
        tooltip: (p) =>
          h(
            'div',
            null,
            h('div', { class: 'tv' }, money(p.revenue)),
            h('div', { class: 'tk' }, pointTitle(p.key)),
            h('div', { class: 'tr', style: { marginTop: '6px' } }, h('span', null, t('tickets_sold')), h('b', null, num(p.people))),
            h('div', { class: 'tr' }, h('span', null, t('orders_count')), h('b', null, num(p.orders))),
          ),
      });
    }

    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { style: { flex: '1' } }, h('h2', null, title), h('div', { class: 'sub' }, periodLabel())), hasData && viewSeg),
      h('div', { class: 'card-body', style: state.view === 'table' && hasData ? { padding: '12px 0 8px' } : {} }, body),
    );
  }

  /* ------------------------- Билет түрлері бойынша ------------------------- */
  function exportCsv() {
    const rows = [[t('col_type'), t('col_qty'), t('col_sum')]];
    for (const row of report.byType) rows.push([row.name, row.qty, row.revenue]);
    rows.push([t('total'), report.totals.people, report.totals.revenue]);
    if (report.byPayment?.length) {
      rows.push([], [t('payment_type'), t('col_qty'), t('col_sum')]);
      for (const row of report.byPayment) rows.push([paymentLabel(row.name), row.qty, row.revenue]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `astral-${report.period}-${report.date ?? 'all'}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function typesCard() {
    const rows = report.byType;
    return h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('div', { style: { flex: '1' } }, h('h2', null, t('by_types')), h('div', { class: 'sub' }, periodLabel())),
        rows.length > 0 && h('button', { class: 'btn btn-ghost btn-sm', onclick: exportCsv }, icon('download', 'icon icon-sm'), t('export_csv')),
      ),
      rows.length ? typesTable(rows, report.totals) : h('div', { class: 'card-body' }, emptyState({ iconName: 'tag', title: t('no_data') })),
    );
  }

  /* ------------------------- Төлем түрлері бойынша ------------------------- */
  function paymentsCard() {
    if (!report.byPayment?.length) return null;
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('wallet'), h('div', { style: { flex: '1' } }, h('h2', null, t('by_payment')), h('div', { class: 'sub' }, periodLabel()))),
      h('div', { class: 'card-body' }, paymentBreakdown(report.byPayment, report.totals.revenue)),
    );
  }

  function renderContent() {
    if (!report) return;
    mount(content, kpis(), h('div', { class: 'report-grid' }, h('div', { class: 'stack' }, paymentsCard(), typesCard()), chartCard()));
  }

  renderFilters();
  load();

  return {
    el,
    onEvent(type) {
      if (type === 'queue') load();
    },
  };
}
