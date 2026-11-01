import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { money } from '../core/format.js';
import { confirmDialog, emptyState, openModal, spinner, toast, withBusy } from '../core/ui.js';
import { pageHead } from './shared.js';
import { env } from '../core/env.js';

const PALETTE = 8;

/** Билет түрлері: қосу, өзгерту, жасыру, реттеу, жою. */
export function typesPage() {
  const el = h('div', { class: 'page' }, pageHead(t('types_title'), t('types_lead')), spinner());
  let types = [];

  async function load() {
    try {
      types = await api('/admin/types?all=1');
      render();
    } catch (err) {
      if (err.status !== 401) toast(errorText(err), 'error');
    }
  }

  async function save(id, body) {
    const saved = await api(id ? `/admin/types/${id}` : '/admin/types', { method: id ? 'PATCH' : 'POST', body });
    await load();
    return saved;
  }

  async function toggleActive(type, input) {
    try {
      await save(type.id, { active: input.checked });
    } catch (err) {
      input.checked = !input.checked;
      toast(errorText(err), 'error');
    }
  }

  async function move(index, delta) {
    const ids = types.map((type) => type.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      types = await api('/admin/types/reorder', { method: 'POST', body: { ids } });
      render();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function remove(type) {
    const ok = await confirmDialog({
      title: t('delete'),
      message: t('delete_type_confirm', { name: type.name }),
      confirmText: t('delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/admin/types/${type.id}`, { method: 'DELETE' });
      toast(t('deleted'));
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  function openEditor(type = null) {
    const used = new Set(types.map((x) => x.color));
    let color = type?.color ?? [...Array(PALETTE).keys()].find((c) => !used.has(c)) ?? types.length % PALETTE;

    const error = h('p', { class: 'error-text', hidden: true });
    const nameInput = h('input', { class: 'input', name: 'name', maxlength: '60', required: true, placeholder: t('name_ph'), value: type?.name ?? '', autofocus: true });
    const priceInput = h('input', {
      class: 'input',
      name: 'price',
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      step: '1',
      required: true,
      placeholder: '0',
      value: type ? String(type.price) : '',
    });
    const descInput = h('input', { class: 'input', name: 'description', maxlength: '160', placeholder: t('description_ph'), value: type?.description ?? '' });
    const activeInput = h('input', { type: 'checkbox', checked: type ? type.active : true });

    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('color') });
    const drawSwatches = () =>
      mount(
        swatches,
        [...Array(PALETTE).keys()].map((c) =>
          h('button', {
            type: 'button',
            class: 'swatch',
            role: 'radio',
            'aria-checked': String(c === color),
            'aria-label': `${t('color')} ${c + 1}`,
            style: { '--sw': `var(--c${c})` },
            onclick: () => {
              color = c;
              drawSwatches();
            },
          }),
        ),
      );
    drawSwatches();

    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), t('save'));
    const form = h(
      'form',
      {
        class: 'form-grid',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          const body = {
            name: nameInput.value.trim(),
            price: Number(priceInput.value),
            description: descInput.value.trim(),
            color,
            active: activeInput.checked,
          };
          if (!body.name) return showError('invalid_name', nameInput);
          if (priceInput.value === '' || !Number.isInteger(body.price) || body.price < 0) return showError('invalid_price', priceInput);
          await withBusy(submit, async () => {
            try {
              await save(type?.id, body);
              modal.close();
              toast(t('saved'));
            } catch (err) {
              showError(err.code, null, err);
            }
          });
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('name')), nameInput),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'label' }, t('price')),
        h('div', { class: 'input-affix' }, priceInput, h('span', { class: 'affix' }, '₸')),
      ),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('description')), descInput),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('color')), swatches),
      h('label', { class: 'switch' }, activeInput, h('span', { class: 'track' }), h('span', null, t('show_in_cashier'))),
      error,
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '4px' } }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, t('cancel')), submit),
    );

    function showError(code, input, err) {
      error.textContent = err ? errorText(err) : t(code);
      error.hidden = false;
      for (const field of [nameInput, priceInput]) field.removeAttribute('aria-invalid');
      const target = input ?? (code === 'invalid_price' ? priceInput : code === 'invalid_name' ? nameInput : null);
      if (target) {
        target.setAttribute('aria-invalid', 'true');
        target.focus();
      }
    }

    const modal = openModal({ title: type ? t('edit_type') : t('new_type'), body: form });
  }

  function row(type, index) {
    const activeInput = h('input', { type: 'checkbox', checked: type.active, onchange: (e) => toggleActive(type, e.target) });
    return h(
      'div',
      { class: ['type-row', !type.active && 'inactive'], style: { '--tc': `var(--c${type.color})` } },
      h(
        'div',
        { class: 'reorder' },
        h('button', { type: 'button', 'aria-label': t('move_up'), disabled: index === 0, onclick: () => move(index, -1) }, icon('chevronUp', 'icon icon-sm')),
        h('button', { type: 'button', 'aria-label': t('move_down'), disabled: index === types.length - 1, onclick: () => move(index, 1) }, icon('chevronDown', 'icon icon-sm')),
      ),
      h(
        'div',
        { class: 'type-row-main' },
        h('div', { class: 'avatar' }),
        h(
          'div',
          { style: { minWidth: '0', flex: '1' } },
          h('div', { class: 'title' }, type.name, !type.active && h('span', { class: 'chip', style: { marginLeft: '8px' } }, t('hidden'))),
          type.description && h('div', { class: 'desc' }, type.description),
        ),
        h('div', { class: 'price' }, money(type.price)),
      ),
      h(
        'div',
        { class: 'actions' },
        h('label', { class: 'switch', title: t('show_in_cashier') }, activeInput, h('span', { class: 'track' }), h('span', { class: 'sr-only' }, t('show_in_cashier'))),
        h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': t('edit_type'), onclick: () => openEditor(type) }, icon('edit')),
        h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': t('delete'), onclick: () => remove(type) }, icon('trash')),
      ),
    );
  }

  function render() {
    const addBtn = h('button', { class: 'btn btn-primary', onclick: () => openEditor() }, icon('plus'), t('new_type'));
    mount(
      el,
      pageHead(t('types_title'), t('types_lead'), addBtn),
      h(
        'section',
        { class: 'card' },
        types.length
          ? h('div', { class: 'list', style: { padding: '6px 0' } }, types.map(row))
          : emptyState({ iconName: 'tag', title: t('no_types_title'), text: t('no_types_text'), action: h('button', { class: 'btn btn-primary', onclick: () => openEditor() }, icon('plus'), t('add_type')) }),
      ),
    );
  }

  load().then(() => {
    // Кассадан «Билет түрін қосу» арқылы келсе — бірден форманы ашу
    if (env.artifact ? location.hash === '#types-new' : new URLSearchParams(location.search).has('new')) {
      try {
        history.replaceState(null, '', env.artifact ? '#types' : '/admin/types');
      } catch {
        /* sandbox iframe-та history API бұғатталуы мүмкін */
      }
      openEditor();
    }
  });

  return {
    el,
    onEvent(type) {
      if (type === 'types') load();
    },
  };
}
