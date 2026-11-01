import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { money } from '../core/format.js';
import { emptyState, spinner, toast, withBusy } from '../core/ui.js';
import { pageHead, showOrderModal, store } from './shared.js';

const MAX_QTY = 999;

/** Касса: билет түрлерін санымен таңдау → «Кезек беру» → QR. */
export function cashierPage({ navigate }) {
  const el = h('div', { class: 'page' }, pageHead(t('cashier_title'), t('cashier_lead')), spinner());
  const cart = store.cart;
  let types = [];
  const cards = new Map();
  const summaries = [];

  function totals() {
    let count = 0;
    let sum = 0;
    for (const type of types) {
      const qty = cart.get(type.id) ?? 0;
      count += qty;
      sum += qty * type.price;
    }
    return { count, sum };
  }

  function setQty(id, qty) {
    const value = Math.max(0, Math.min(MAX_QTY, Number.isFinite(qty) ? Math.floor(qty) : 0));
    if (value) cart.set(id, value);
    else cart.delete(id);
    cards.get(id)?.update();
    for (const update of summaries) update();
  }

  function typeCard(type) {
    const qtyInput = h('input', {
      class: 'qty',
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      max: String(MAX_QTY),
      'aria-label': `${type.name} — ${t('col_qty')}`,
      onclick: (e) => e.stopPropagation(),
      onfocus: (e) => e.target.select(),
      oninput: (e) => setQty(type.id, Number(e.target.value)),
    });
    const minus = h(
      'button',
      { type: 'button', 'aria-label': `${type.name}: −1`, onclick: (e) => (e.stopPropagation(), setQty(type.id, (cart.get(type.id) ?? 0) - 1)) },
      icon('minus'),
    );
    const plus = h(
      'button',
      { type: 'button', 'aria-label': `${type.name}: +1`, onclick: (e) => (e.stopPropagation(), setQty(type.id, (cart.get(type.id) ?? 0) + 1)) },
      icon('plus'),
    );
    const badgeSlot = h('div');

    const card = h(
      'div',
      { class: 'type-card', style: { '--tc': `var(--c${type.color})` }, onclick: () => setQty(type.id, (cart.get(type.id) ?? 0) + 1) },
      badgeSlot,
      h('div', { class: 'type-name' }, type.name),
      type.description && h('div', { class: 'type-desc' }, type.description),
      h('div', { class: 'type-price' }, money(type.price)),
      h('div', { class: 'stepper' }, minus, qtyInput, plus),
    );

    const update = () => {
      const qty = cart.get(type.id) ?? 0;
      card.classList.toggle('selected', qty > 0);
      if (document.activeElement !== qtyInput) qtyInput.value = String(qty);
      minus.disabled = qty === 0;
      plus.disabled = qty >= MAX_QTY;
      mount(badgeSlot, qty > 0 ? h('div', { class: 'type-qty-badge', 'aria-hidden': 'true' }, String(qty)) : null);
    };
    qtyInput.addEventListener('blur', update);
    update();
    cards.set(type.id, { update });
    return card;
  }

  async function issue(button) {
    const items = types
      .filter((type) => (cart.get(type.id) ?? 0) > 0)
      .map((type) => ({ ticketTypeId: type.id, qty: cart.get(type.id) }));
    if (!items.length) return toast(t('empty_cart'), 'error');
    await withBusy(button, async () => {
      try {
        const order = await api('/admin/orders', { method: 'POST', body: { items } });
        cart.clear();
        render();
        showOrderModal(order, { mode: 'issued' });
      } catch (err) {
        toast(errorText(err), 'error');
        if (err.code === 'invalid_ticket_type') load();
      }
    });
  }

  /** Жұмыс үстеліндегі оң жақ панель. */
  function cartPanel() {
    const lines = h('div', { class: 'cart-lines' });
    const totalSum = h('span', { class: 'sum' });
    const count = h('span', { class: 'muted' });
    const issueBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', onclick: (e) => issue(e.currentTarget) }, icon('qr'), t('issue_btn'));
    const clearBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => (cart.clear(), render()) }, t('clear'));

    summaries.push(() => {
      const { count: n, sum } = totals();
      const chosen = types.filter((type) => cart.get(type.id));
      mount(
        lines,
        chosen.length
          ? chosen.map((type) =>
              h(
                'div',
                { class: 'cart-line' },
                h('span', { class: 'dot', style: { '--dot': `var(--c${type.color})` } }),
                h('span', { class: 'name' }, type.name, h('span', { class: 'qty' }, `×${cart.get(type.id)}`)),
                h('span', { class: 'num' }, money(type.price * cart.get(type.id))),
              ),
            )
          : h('p', { class: 'faint small' }, t('empty_cart')),
      );
      totalSum.textContent = money(sum);
      count.textContent = t('tickets_count', { n });
      issueBtn.disabled = n === 0;
      clearBtn.hidden = n === 0;
    });

    return h(
      'aside',
      { class: 'card cart-panel' },
      h('div', { class: 'card-head' }, h('h2', null, t('order')), h('div', { class: 'spacer' }), clearBtn),
      h(
        'div',
        { class: 'card-body stack' },
        lines,
        h('hr', { class: 'divider', style: { margin: '0' } }),
        h('div', { class: 'cart-total' }, h('div', null, h('div', { class: 'faint small' }, t('total')), count), totalSum),
        issueBtn,
        h('p', { class: 'hint', style: { textAlign: 'center' } }, t('issue_hint')),
      ),
    );
  }

  /** Телефондағы төменгі жолақ. */
  function cartBar() {
    const count = h('div', { class: 'count' });
    const sum = h('div', { class: 'sum' });
    const bar = h(
      'div',
      { class: 'cartbar' },
      h('div', { class: 'info' }, count, sum),
      h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': t('clear'), onclick: () => (cart.clear(), render()) }, icon('trash')),
      h('button', { class: 'btn btn-primary', onclick: (e) => issue(e.currentTarget) }, icon('qr'), t('issue_btn')),
    );
    summaries.push(() => {
      const { count: n, sum: s } = totals();
      bar.hidden = n === 0;
      count.textContent = t('tickets_count', { n });
      sum.textContent = money(s);
    });
    return bar;
  }

  function render() {
    cards.clear();
    summaries.length = 0;
    if (!types.length) {
      mount(
        el,
        pageHead(t('cashier_title'), t('cashier_lead')),
        h(
          'div',
          { class: 'card' },
          emptyState({
            iconName: 'tag',
            title: t('no_types_title'),
            text: t('no_types_text'),
            action: h('button', { class: 'btn btn-primary', onclick: () => navigate('/admin/types?new=1') }, icon('plus'), t('add_type')),
          }),
        ),
      );
      return;
    }
    mount(
      el,
      pageHead(t('cashier_title'), t('cashier_lead')),
      h('div', { class: 'pos' }, h('div', { class: 'types-grid' }, types.map(typeCard)), cartPanel()),
      cartBar(),
    );
    for (const update of summaries) update();
  }

  async function load() {
    try {
      types = await api('/admin/types');
      for (const id of [...cart.keys()]) if (!types.some((type) => type.id === id)) cart.delete(id);
      render();
    } catch (err) {
      if (err.status !== 401) toast(errorText(err), 'error');
    }
  }

  load();
  return {
    el,
    onEvent(type) {
      if (type === 'types') load();
    },
  };
}
