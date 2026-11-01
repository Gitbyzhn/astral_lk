import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { dateTime, money, num } from '../core/format.js';
import { chime, unlockAudio, vibrate } from '../core/media.js';
import { copyText, emptyState, spinner, statusChip, toast } from '../core/ui.js';
import { env } from '../core/env.js';
import { clientHeader } from './common.js';
import { rememberTicket } from './saved.js';

const NOTIFY_KEY = 'astral.notify';

/** Клиент талоны: кезек нөмірі, алдында қанша топ, қазір кім шақырылды. Өздігінен жаңарады. */
export function ticketPage({ params, info }) {
  const code = String(params.code || '').toLowerCase();
  const header = () => clientHeader(info);
  const el = h('div', { class: 'client' }, header(), spinner());

  let data = null;
  let failed = null;
  let online = true;
  let notifyOn = false;
  try {
    notifyOn = localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    /* сақтау орны жабық */
  }
  let maxAhead = 0;
  const baseTitle = document.title;

  // Кез келген түртуден кейін дыбысқа рұқсат аламыз (браузер талабы).
  const unlock = () => unlockAudio();
  document.addEventListener('pointerdown', unlock, { once: true });


  async function load() {
    try {
      const next = await api(`/public/orders/${encodeURIComponent(code)}`);
      const prev = data;
      data = next;
      failed = null;
      maxAhead = rememberTicket(next.order, next.queue.ahead).maxAhead;
      if (prev) react(prev, next);
      render();
    } catch (err) {
      if (err.status === 404) {
        failed = 'not_found';
        render();
      } else if (!data) {
        failed = 'network';
        render();
      }
    }
  }

  /** Күй өзгерсе: дыбыс, діріл, хабарлама. */
  function react(prev, next) {
    const order = next.order;
    const called = order.status === 'serving' && (prev.order.status !== 'serving' || prev.order.calledAt !== order.calledAt);
    if (called) {
      vibrate();
      chime();
      document.title = `🔔 ${t('your_turn')}`;
      if (notifyOn && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        navigator.serviceWorker?.ready
          .then((reg) =>
            reg.showNotification(t('your_turn'), {
              body: `№${order.number} · ${t('your_turn_text')}`,
              tag: `turn-${order.code}`,
              renotify: true,
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-192.png',
              vibrate: [300, 120, 300, 120, 600],
              data: { url: location.href },
            }),
          )
          .catch(() => {});
      }
    } else if (order.status === 'waiting' && next.queue.ahead === 0 && prev.queue.ahead > 0) {
      vibrate([160, 80, 160]);
    }
    if (order.status !== 'serving') document.title = baseTitle;
  }

  async function enableNotify() {
    unlockAudio();
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* қолдау жоқ */
      }
    }
    notifyOn = true;
    try {
      localStorage.setItem(NOTIFY_KEY, '1');
    } catch {
      /* сақтау орны жабық */
    }
    chime();
    vibrate([120]);
    toast(t('notify_on'));
    render();
  }

  async function share() {
    const url = location.href;
    const text = t('share_text', { n: data.order.number });
    // Claude сілтемесінде Web Share жұмыс істемейді — сілтемені көшіреміз
    if (navigator.share && !env.artifact) {
      try {
        await navigator.share({ title: info.businessName, text, url });
      } catch {
        /* пайдаланушы бас тартты */
      }
    } else if (await copyText(url)) {
      toast(t('link_copied'));
    }
  }

  function statusBlock() {
    const { order, queue } = data;
    if (order.status === 'serving') {
      return h('div', { class: 'turn-banner', role: 'alert' }, h('strong', null, t('your_turn')), t('your_turn_text'));
    }
    if (order.status === 'done') return h('div', { class: 'closed-banner' }, t('served_thanks'));
    if (order.status === 'cancelled') return h('div', { class: 'closed-banner' }, t('cancelled_text'));

    const progress = maxAhead > 0 ? ((maxAhead - queue.ahead) / maxAhead) * 100 : 100;
    const serving = queue.serving.length ? `№${queue.serving.join(', №')}` : '—';
    return [
      h('div', { class: 'ticket-cut', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'ticket-stats' },
        h(
          'div',
          { class: 'ticket-stat' },
          h('div', { class: 'v' }, num(queue.ahead)),
          h('div', { class: 'l' }, t('ahead_of_you')),
          queue.ahead > 0 && queue.aheadPeople > 0 && h('div', { class: 's' }, t('people_count', { n: queue.aheadPeople })),
        ),
        h('div', { class: 'ticket-stat' }, h('div', { class: 'v' }, serving), h('div', { class: 'l' }, t('now_called_short'))),
      ),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(progress)) }, h('div', { style: { width: `${Math.max(4, progress)}%` } })),
      queue.ahead === 0 && h('p', { class: 'muted', style: { marginTop: '14px', fontWeight: '650' } }, t('you_are_next')),
    ];
  }

  function render() {
    if (failed === 'not_found' || (failed && !data)) {
      mount(
        el,
        header(),
        h(
          'div',
          { class: 'card' },
          emptyState({
            iconName: failed === 'not_found' ? 'ticket' : 'alert',
            title: failed === 'not_found' ? t('ticket_not_found') : t('error_network'),
            text: failed === 'not_found' ? t('ticket_not_found_text') : null,
            action:
              failed === 'not_found'
                ? h('a', { class: 'btn btn-soft', href: '/', 'data-link': true }, t('go_home'))
                : h('button', { class: 'btn btn-soft', onclick: load }, icon('refresh'), t('refresh')),
          }),
        ),
      );
      return;
    }

    const { order } = data;
    const closed = order.status === 'done' || order.status === 'cancelled';
    const ticket = h(
      'section',
      { class: ['card ticket', order.status === 'serving' && 'is-serving', closed && 'is-closed'], 'aria-live': 'polite' },
      h('div', { class: 'issued-label' }, t('your_number')),
      h('div', { class: 'big-number' }, h('span', { class: 'hash' }, '№'), String(order.number)),
      h('div', { class: 'ticket-status' }, statusChip(order.status)),
      statusBlock(),
    );

    const items = h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { style: { flex: '1' } }, t('tickets')), h('span', { class: 'sub' }, dateTime(order.createdAt))),
      h(
        'div',
        { class: 'card-body' },
        h(
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
          h('div', { class: 'items-total' }, h('span', null, `${t('total')} · ${t('people_count', { n: order.people })}`), h('span', { class: 'sum' }, money(order.total))),
        ),
      ),
    );

    // Кезек келгенде «Хабарлау» түймесі қажет емес — тек «Бөлісу» қалады.
    const waiting = order.status === 'waiting';
    // Хабарлама мен дыбыс Claude сілтемесінің ішінде жұмыс істемейді
    const canNotify = waiting && !env.artifact;
    const actions = closed
      ? null
      : h(
          'div',
          { class: 'client-actions', style: canNotify ? {} : { gridTemplateColumns: '1fr' } },
          h('button', { class: 'btn btn-soft', onclick: share }, icon('share'), t('share')),
          canNotify &&
            (notifyOn
              ? h('button', { class: 'btn btn-ghost', 'aria-pressed': 'true', onclick: () => (unlockAudio(), chime()) }, icon('bell'), t('notify_on'))
              : h('button', { class: 'btn btn-primary', onclick: enableNotify }, icon('bell'), t('notify_me'))),
        );

    mount(
      el,
      header(),
      ticket,
      actions,
      canNotify && !notifyOn && h('p', { class: 'hint', style: { textAlign: 'center', marginTop: '-6px' } }, t('notify_hint')),
      items,
      h(
        'footer',
        { class: 'client-foot' },
        h('span', { class: ['live', online && 'on'] }, online ? t('auto_update') : t('offline')),
        h('a', { href: '/', 'data-link': true }, t('my_tickets')),
      ),
    );
  }

  load();

  return {
    el,
    onEvent(type) {
      if (type === 'queue' || type === 'resync') load();
    },
    setOnline(value) {
      online = value;
      if (data) render();
    },
    destroy() {
      document.removeEventListener('pointerdown', unlock);
      document.title = baseTitle;
    },
  };
}
