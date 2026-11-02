import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { money } from '../core/format.js';
import { emptyState, openModal, spinner, toast, withBusy } from '../core/ui.js';
import { pageHead, showOrderModal, store } from './shared.js';

const MAX_QTY = 999;

/**
 * Касса: билет түрлерін санымен таңдау → төлем түрі (әдепкісі, мысалы, Каспий) → «Кезек беру» → QR.
 * Топта әркім әртүрлі төлесе — «Әр билетке бөлек» терезесінде әр билеттің төлем түрі таңдалады.
 * Әкімші бетінде де, касса кабинетінде де (/kassa) бірдей.
 */
export function cashierPage({ navigate }) {
  const el = h('div', { class: 'page' }, pageHead(t('cashier_title'), t('cashier_lead')), spinner());
  const cart = store.cart;
  let types = [];
  let methods = [];
  let defaultPm = null;
  const cards = new Map();
  const updaters = [];

  /* ------------------------------- Төлем түрі ------------------------------- */
  const hasMethod = (id) => id != null && methods.some((m) => m.id === id);
  /** Бүкіл тапсырыстың төлем түрі: кассир таңдағаны, болмаса әдепкісі. */
  const orderPm = () => (hasMethod(store.payment) ? store.payment : defaultPm);
  /** i-билеттің төлем түрі: жеке таңдалса — сол, әйтпесе тапсырыстікі. */
  const unitPm = (typeId, i) => {
    const pm = store.unitPay.get(typeId)?.[i];
    return hasMethod(pm) ? pm : orderPm();
  };
  const methodIndex = (id) => methods.findIndex((m) => m.id === id);

  /** Таңдалған билеттер (билет түрі × төлем түрі): [{ type, pm, qty }] */
  function lines() {
    const out = [];
    for (const type of types) {
      const qty = cart.get(type.id) ?? 0;
      const byPm = new Map();
      for (let i = 0; i < qty; i++) {
        const pm = unitPm(type.id, i);
        byPm.set(pm, (byPm.get(pm) ?? 0) + 1);
      }
      for (const pm of [...byPm.keys()].sort((a, b) => methodIndex(a) - methodIndex(b))) out.push({ type, pm, qty: byPm.get(pm) });
    }
    return out;
  }

  /** Барлық билет бір төлем түрімен болса — сол түр, аралас болса — null. */
  function uniformPm() {
    const pms = new Set(lines().map((line) => line.pm));
    if (pms.size === 0) return orderPm();
    return pms.size === 1 ? [...pms][0] : null;
  }

  /** Төлем түрлері бойынша алынатын сома: [{ pm, sum }] */
  function collectTotals() {
    const sums = new Map();
    for (const line of lines()) sums.set(line.pm, (sums.get(line.pm) ?? 0) + line.qty * line.type.price);
    return [...sums].map(([pm, sum]) => ({ pm, sum }));
  }

  const methodName = (id) => methods.find((m) => m.id === id)?.name ?? '';

  function setOrderPayment(pm) {
    store.payment = pm;
    store.unitPay.clear(); // барлық билет осы түрмен
    refresh();
  }

  function setUnitPayment(typeId, index, pm) {
    const list = store.unitPay.get(typeId) ?? [];
    list[index] = pm;
    store.unitPay.set(typeId, list);
    refresh();
  }

  /** [Наличка] [Каспий] [Банк] */
  function paySeg(current, onPick, { small = false, label = t('payment_type') } = {}) {
    return h(
      'div',
      { class: ['seg pay-seg', small && 'sm'], role: 'group', 'aria-label': label },
      methods.map((m) => h('button', { type: 'button', 'aria-pressed': String(current === m.id), onclick: () => onPick(m.id) }, m.name)),
    );
  }

  /* ------------------------------- Билеттер ------------------------------- */
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

  function refresh() {
    for (const card of cards.values()) card.update();
    for (const update of updaters) update();
  }

  function setQty(id, qty) {
    const value = Math.max(0, Math.min(MAX_QTY, Number.isFinite(qty) ? Math.floor(qty) : 0));
    if (value) cart.set(id, value);
    else cart.delete(id);
    // Азайса — артық билеттердің жеке төлем түрлері ұмытылады
    const own = store.unitPay.get(id);
    if (own && own.length > value) own.length = value;
    refresh();
  }

  function resetOrder() {
    cart.clear();
    store.unitPay.clear();
    store.payment = null; // келесі клиентке қайтадан әдепкі төлем түрі
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
    const items = lines().map((line) => ({
      ticketTypeId: line.type.id,
      qty: line.qty,
      ...(line.pm != null && { paymentMethodId: line.pm }),
    }));
    if (!items.length) return toast(t('empty_cart'), 'error');
    await withBusy(button, async () => {
      try {
        const order = await api('/kassa/orders', { method: 'POST', body: { items } });
        resetOrder();
        render();
        showOrderModal(order, { mode: 'issued' });
      } catch (err) {
        toast(errorText(err), 'error');
        if (err.code === 'invalid_ticket_type' || err.code === 'invalid_payment_method') load();
      }
    });
  }

  /* ------------------------ Әр билеттің төлем түрі ------------------------ */
  function collectBlock() {
    const sums = collectTotals();
    if (sums.length < 2) return null;
    return h(
      'div',
      { class: 'pay-split' },
      h('span', { class: 'faint' }, `${t('to_collect')}:`),
      sums.map(({ pm, sum }) => h('span', null, `${methodName(pm)} `, h('b', null, money(sum)))),
    );
  }

  function openSplit() {
    const body = h('div', { class: 'split' });
    const draw = () => {
      const rows = [];
      for (const type of types) {
        const qty = cart.get(type.id) ?? 0;
        if (!qty) continue;
        rows.push(
          h(
            'div',
            { class: 'split-type' },
            h('span', { class: 'dot', style: { '--dot': `var(--c${type.color})` } }),
            h('b', null, type.name),
            h('span', { class: 'faint' }, money(type.price)),
          ),
        );
        for (let i = 0; i < qty; i++) {
          rows.push(
            h(
              'div',
              { class: 'split-row' },
              h('span', { class: 'split-n' }, String(i + 1)),
              paySeg(unitPm(type.id, i), (pm) => (setUnitPayment(type.id, i, pm), draw()), { small: true, label: `${type.name} ${i + 1}` }),
            ),
          );
        }
      }
      mount(
        body,
        h('p', { class: 'muted small' }, t('split_payment_lead')),
        h('div', { class: 'split-all' }, h('span', { class: 'label' }, t('set_all')), paySeg(uniformPm(), (pm) => (setOrderPayment(pm), draw()), { small: true })),
        h('div', { class: 'split-list' }, rows),
        collectBlock(),
      );
    };
    draw();
    const modal = openModal({
      title: t('split_payment_title'),
      body,
      footer: h('button', { class: 'btn btn-primary btn-lg btn-block', autofocus: true, onclick: () => modal.close() }, icon('check'), t('done')),
    });
  }

  /** Төлем түрін таңдау блогы: бүкіл тапсырысқа + «Әр билетке бөлек». */
  function paymentPicker({ compact = false } = {}) {
    if (!methods.length) return null;
    const current = uniformPm();
    const { count } = totals();
    const canSplit = methods.length > 1 && count > 1;
    const splitBtn =
      canSplit &&
      (compact
        ? h('button', { class: ['btn btn-icon', current === null ? 'btn-soft' : 'btn-ghost'], 'aria-label': t('split_payment'), title: t('split_payment'), onclick: openSplit }, icon('users'))
        : h('button', { class: 'btn btn-ghost btn-sm', onclick: openSplit }, icon('users', 'icon icon-sm'), t('split_payment')));
    if (compact) return h('div', { class: 'pay-picker compact' }, paySeg(current, setOrderPayment), splitBtn);
    return h(
      'div',
      { class: 'pay-picker' },
      h('div', { class: 'label' }, t('payment_type')),
      paySeg(current, setOrderPayment),
      (splitBtn || current === null) &&
        h('div', { class: 'row wrap', style: { gap: '8px' } }, splitBtn, current === null && h('span', { class: 'chip' }, t('mixed_payment'))),
    );
  }

  /* --------------------------- Тапсырыс қорытындысы --------------------------- */
  /** Жұмыс үстеліндегі оң жақ панель. */
  function cartPanel() {
    const linesSlot = h('div', { class: 'cart-lines' });
    const paySlot = h('div');
    const collectSlot = h('div');
    const totalSum = h('span', { class: 'sum' });
    const count = h('span', { class: 'muted' });
    const issueBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', onclick: (e) => issue(e.currentTarget) }, icon('qr'), t('issue_btn'));
    const clearBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => (resetOrder(), render()) }, t('clear'));

    updaters.push(() => {
      const { count: n, sum } = totals();
      const chosen = lines();
      const showPay = methods.length > 1;
      mount(
        linesSlot,
        chosen.length
          ? chosen.map((line) =>
              h(
                'div',
                { class: 'cart-line' },
                h('span', { class: 'dot', style: { '--dot': `var(--c${line.type.color})` } }),
                h(
                  'span',
                  { class: 'name' },
                  line.type.name,
                  h('span', { class: 'qty' }, `×${line.qty}`),
                  showPay && line.pm != null && h('span', { class: 'pay-tag' }, methodName(line.pm)),
                ),
                h('span', { class: 'num' }, money(line.type.price * line.qty)),
              ),
            )
          : h('p', { class: 'faint small' }, t('empty_cart')),
      );
      mount(paySlot, paymentPicker());
      mount(collectSlot, collectBlock());
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
        linesSlot,
        methods.length > 0 && h('hr', { class: 'divider', style: { margin: '0' } }),
        paySlot,
        h('hr', { class: 'divider', style: { margin: '0' } }),
        h('div', { class: 'cart-total' }, h('div', null, h('div', { class: 'faint small' }, t('total')), count), totalSum),
        collectSlot,
        issueBtn,
        h('p', { class: 'hint', style: { textAlign: 'center' } }, t('issue_hint')),
      ),
    );
  }

  /** Телефондағы төменгі жолақ: төлем түрі және «Кезек беру». */
  function cartBar() {
    const count = h('div', { class: 'count' });
    const sum = h('div', { class: 'sum' });
    const paySlot = h('div', { class: 'cartbar-pay' });
    const bar = h(
      'div',
      { class: 'cartbar' },
      paySlot,
      h(
        'div',
        { class: 'cartbar-main' },
        h('div', { class: 'info' }, count, sum),
        h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': t('clear'), onclick: () => (resetOrder(), render()) }, icon('trash')),
        h('button', { class: 'btn btn-primary', onclick: (e) => issue(e.currentTarget) }, icon('qr'), t('issue_btn')),
      ),
    );
    updaters.push(() => {
      const { count: n, sum: s } = totals();
      bar.hidden = n === 0;
      count.textContent = t('tickets_count', { n });
      sum.textContent = money(s);
      mount(paySlot, methods.length > 1 ? paymentPicker({ compact: true }) : null);
      paySlot.hidden = methods.length < 2;
    });
    return bar;
  }

  function render() {
    cards.clear();
    updaters.length = 0;
    if (!types.length) {
      const isAdmin = store.role === 'admin';
      mount(
        el,
        pageHead(t('cashier_title'), t('cashier_lead')),
        h(
          'div',
          { class: 'card' },
          emptyState({
            iconName: 'tag',
            title: t('no_types_title'),
            text: isAdmin ? t('no_types_text') : t('no_types_cashier'),
            action: isAdmin && h('button', { class: 'btn btn-primary', onclick: () => navigate('/admin/types?new=1') }, icon('plus'), t('add_type')),
          }),
        ),
      );
      return;
    }
    mount(
      el,
      pageHead(t('cashier_title'), t('cashier_lead')),
      h('div', { class: 'pos' }, h('div', { class: 'types-grid' }, types.map(typeCard)), cartPanel()),
      h('div', { class: 'cartbar-spacer', 'aria-hidden': 'true' }),
      cartBar(),
    );
    refresh();
  }

  async function load() {
    try {
      const catalog = await api('/kassa/catalog');
      types = catalog.types;
      methods = catalog.paymentMethods ?? [];
      defaultPm = catalog.defaultPaymentMethodId ?? null;
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
