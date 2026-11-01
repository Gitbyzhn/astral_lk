import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dayLabel, money, monthLabel, num, todayKey } from '../core/format.js';
import { emptyState, spinner, toast } from '../core/ui.js';
import { pageHead } from './shared.js';
import { columnChart } from './chart.js';

// Сүзгі күйі беттер арасында ауысқанда сақталады.
const state = { period: 'day', day: null, month: null, view: 'chart' };

const shiftDay = (day, delta) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const shiftMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

/** Есеп: күндік / айлық / жалпы. Карточкалар, түсім графигі және билет түрлері бойынша кесте. */
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
      const value = isDay ? state.day : state.month;
      const max = isDay ? today : today.slice(0, 7);
      const picker = h('input', {
        type: isDay ? 'date' : 'month',
        value,
        max,
        tabindex: '-1',
        'aria-hidden': 'true',
        onchange: (e) => {
          const v = e.target.value;
          if (!v) return;
          if (isDay) state.day = v > today ? today : v;
          else state.month = v > max ? max : v;
          renderFilters();
          load();
        },
      });
      const step = (delta) => {
        if (isDay) state.day = shiftDay(state.day, delta);
        else state.month = shiftMonth(state.month, delta);
        renderFilters();
        load();
      };
      nav = h(
        'div',
        { class: 'datenav' },
        h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '‹', onclick: () => step(-1) }, icon('chevronLeft')),
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
          h('span', null, isDay ? dayLabel(state.day) : monthLabel(state.month)),
          picker,
        ),
        h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '›', disabled: value >= max, onclick: () => step(1) }, icon('chevronRight')),
      );
    }

    const todayBtn =
      state.period === 'day' && state.day !== today
        ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => ((state.day = today), renderFilters(), load()) }, t('today'))
        : null;

    mount(filters, seg, nav, todayBtn);
  }

  /* ------------------------------ Карточкалар ------------------------------ */
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
    return h(
      'div',
      { class: 'kpis' },
      tile('hero', 'wallet', t('revenue'), money(totals.revenue), periodLabel()),
      tile('', 'ticket', t('tickets_sold'), num(totals.people), t('people_unit')),
      tile('', 'users', t('orders_count'), num(totals.orders), totals.cancelled ? t('cancelled_note', { n: totals.cancelled }) : null),
      tile('', 'receipt', t('avg_check'), money(totals.avgCheck), t('per_group')),
    );
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
    const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `astral-${report.period}-${report.date ?? 'all'}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function typesCard() {
    const total = report.totals.revenue;
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
      rows.length
        ? h(
            'div',
            { class: 'table-wrap', style: { padding: '8px 0 6px' } },
            h(
              'table',
              { class: 'table' },
              h(
                'thead',
                null,
                h('tr', null, h('th', null, t('col_type')), h('th', { class: 'r' }, t('col_qty')), h('th', { class: 'r' }, t('col_sum')), h('th', { class: 'hide-sm' }, t('col_share'))),
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
                h(
                  'tr',
                  null,
                  h('td', null, t('total')),
                  h('td', { class: 'r' }, num(report.totals.people)),
                  h('td', { class: 'r' }, money(total)),
                  h('td', { class: 'hide-sm' }),
                ),
              ),
            ),
          )
        : h('div', { class: 'card-body' }, emptyState({ iconName: 'tag', title: t('no_data') })),
    );
  }

  function renderContent() {
    if (!report) return;
    mount(content, kpis(), h('div', { class: 'report-grid' }, typesCard(), chartCard()));
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
