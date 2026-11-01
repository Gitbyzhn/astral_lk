import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { ago, itemsSummary, money, num, time } from '../core/format.js';
import { emptyState, spinner, statusChip, toast, withBusy } from '../core/ui.js';
import { pageHead, showOrderModal } from './shared.js';

/** Кезек: қазір шақырылған топ, «Келесіні шақыру», күтудегілер және бүгін аяқталғандар. */
export function queuePage({ setBadge }) {
  const el = h('div', { class: 'page' }, pageHead(t('queue'), t('queue_lead')), spinner());
  let data = null;
  let loading = false;
  let pending = false;

  async function load() {
    if (loading) {
      pending = true;
      return;
    }
    loading = true;
    try {
      data = await api('/admin/queue');
      setBadge(data.waiting.length);
      render();
    } catch (err) {
      if (err.status !== 401) toast(errorText(err), 'error');
    } finally {
      loading = false;
      if (pending) {
        pending = false;
        load();
      }
    }
  }

  async function callNext(button) {
    await withBusy(button, async () => {
      try {
        const result = await api('/admin/queue/next', { method: 'POST' });
        data = result;
        setBadge(data.waiting.length);
        render();
        toast(result.called ? t('called_toast', { n: result.called.number }) : t('finished_toast'));
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });
  }

  async function setStatus(button, order, status) {
    await withBusy(button, async () => {
      try {
        await api(`/admin/orders/${order.id}`, { method: 'PATCH', body: { status } });
        if (status === 'serving') toast(t('called_toast', { n: order.number }));
        await load();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    });
  }

  const openOrder = (order) => showOrderModal(order, { onChanged: load });

  function nowCard() {
    const current = data.serving[0];
    const next = data.waiting[0];
    const nextBtn = h(
      'button',
      {
        class: 'btn btn-primary btn-lg btn-block next-btn',
        disabled: !next && !current,
        onclick: (e) => callNext(e.currentTarget),
      },
      icon('megaphone'),
      next ? t('call_next_n', { n: next.number }) : t('call_next'),
    );

    if (!current) {
      return h(
        'div',
        { class: 'card now-card empty-state' },
        h('div', { class: 'now-head' }, h('span', { class: 'issued-label' }, t('now_serving'))),
        h('div', { class: 'now-number faint' }, '—'),
        h('div', { class: 'now-meta' }, t('nobody_called')),
        nextBtn,
      );
    }

    return h(
      'div',
      { class: 'card now-card' },
      h('div', { class: 'now-head' }, h('span', { class: 'issued-label' }, t('now_serving')), statusChip('serving')),
      h('div', { class: 'now-number' }, `№${current.number}`),
      h('div', { class: 'now-meta' }, `${t('people_count', { n: current.people })} · ${itemsSummary(current.items)}`),
      h('div', { class: 'now-meta faint small' }, `${time(current.createdAt)} → ${time(current.calledAt)}`),
      h(
        'div',
        { class: 'now-actions' },
        h('button', { class: 'btn btn-success', onclick: (e) => setStatus(e.currentTarget, current, 'done') }, icon('check'), t('finish')),
        h('button', { class: 'btn btn-soft', onclick: (e) => setStatus(e.currentTarget, current, 'serving') }, icon('megaphone'), t('recall')),
      ),
      nextBtn,
    );
  }

  function miniStats() {
    const stat = (value, label) => h('div', { class: 'mini-stat' }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label));
    return h(
      'div',
      { class: 'mini-stats' },
      stat(num(data.waiting.length), t('waiting')),
      stat(num(data.today.done), t('served_today')),
      stat(money(data.today.revenue), t('revenue_today')),
    );
  }

  function orderRow(order, index) {
    const isWaiting = order.status === 'waiting';
    return h(
      'div',
      { class: 'list-item', onclick: () => openOrder(order), role: 'button', tabindex: '0', onkeydown: (e) => e.key === 'Enter' && openOrder(order) },
      h('div', { class: ['qnum', isWaiting && index === 0 && 'first'] }, String(order.number)),
      h(
        'div',
        { class: 'qbody' },
        h('div', { class: 'qitems' }, itemsSummary(order.items)),
        h(
          'div',
          { class: 'qmeta' },
          h('span', null, icon('users', 'icon icon-sm'), t('people_count', { n: order.people })),
          h('span', null, icon('clock', 'icon icon-sm'), isWaiting ? ago(order.createdAt) : time(order.doneAt || order.createdAt)),
          h('span', { class: 'num' }, money(order.total)),
        ),
      ),
      isWaiting
        ? h(
            'button',
            {
              class: 'btn btn-soft btn-sm',
              onclick: (e) => {
                e.stopPropagation();
                setStatus(e.currentTarget, order, 'serving');
              },
            },
            t('call'),
          )
        : statusChip(order.status),
    );
  }

  function render() {
    const waitingCard = h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, t('waiting')), h('span', { class: 'badge' }, String(data.waiting.length))),
      h(
        'div',
        { class: 'card-body', style: { padding: data.waiting.length ? '8px 0 4px' : undefined } },
        data.waiting.length
          ? h('div', { class: 'list' }, data.waiting.map(orderRow))
          : emptyState({ iconName: 'users', title: t('queue_empty'), text: t('queue_empty_text') }),
      ),
    );

    const recentCard =
      data.recent.length > 0 &&
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, t('closed_today')), h('span', { class: 'sub' }, String(data.recent.length))),
        h('div', { class: 'card-body', style: { padding: '8px 0 4px' } }, h('div', { class: 'list' }, data.recent.map(orderRow))),
      );

    mount(
      el,
      pageHead(t('queue'), t('queue_lead')),
      h(
        'div',
        { class: 'queue-layout' },
        h('div', { class: 'now-col' }, nowCard(), miniStats()),
        h('div', { class: 'stack' }, waitingCard, recentCard),
      ),
    );
  }

  load();
  // «N мин бұрын» жазуларын жаңартып отыру
  const timer = setInterval(() => data && render(), 30_000);

  return {
    el,
    onEvent(type) {
      if (type === 'queue' || type === 'resync') load();
    },
    destroy() {
      clearInterval(timer);
    },
  };
}
