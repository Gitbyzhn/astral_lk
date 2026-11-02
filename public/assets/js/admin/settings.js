import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api, auth } from '../core/api.js';
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from '../core/pwa.js';
import { confirmDialog, copyText, langToggle, openModal, toast, withBusy } from '../core/ui.js';
import { qrSvg } from '../core/qr.js';
import { pageHead, paymentColor, store } from './shared.js';
import { env } from '../core/env.js';

/** Баптаулар: мекеме атауы, төлем түрлері, әкімші/касса сілтемелері, құпиясөз, экрандар, тіл. */
export function settingsPage({ onLogout, refreshShell }) {
  const el = h('div', { class: 'page' });
  // Екі сілтеме картасына бір сұрау
  const secrets = env.artifact ? Promise.resolve(null) : api('/admin/settings').catch(() => null);

  function businessCard() {
    const input = h('input', { class: 'input', maxlength: '60', value: store.info.businessName, required: true });
    // Claude сілтемесінде QR ішіне жазылатын жария сілтеме (Share → Public link)
    const linkInput = env.artifact
      ? h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://claude.ai/…', value: store.info.publicUrl || '' })
      : null;
    const error = h('p', { class: 'error-text', hidden: true });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), t('save'));
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('store'), h('h2', null, t('business'))),
      h(
        'form',
        {
          class: 'card-body form-grid',
          onsubmit: async (e) => {
            e.preventDefault();
            error.hidden = true;
            await withBusy(button, async () => {
              try {
                const body = { businessName: input.value };
                if (linkInput) body.publicUrl = linkInput.value.trim();
                store.info = { ...store.info, ...(await api('/admin/settings', { method: 'PATCH', body })) };
                toast(t('saved'));
                refreshShell();
              } catch (err) {
                error.textContent = errorText(err);
                error.hidden = false;
              }
            });
          },
        },
        h('label', { class: 'field' }, h('span', { class: 'label' }, t('business_name')), input, h('span', { class: 'hint' }, t('business_name_hint'))),
        linkInput &&
          h('label', { class: 'field' }, h('span', { class: 'label' }, t('public_link')), linkInput, h('span', { class: 'hint' }, t('public_link_hint'))),
        error,
        h('div', null, button),
      ),
    );
  }

  /**
   * Кіру сілтемесі — аккаунтсыз, құпиясөзсіз:
   *   'admin' — әкімші беті (/admin#key=…), 'kassa' — кассирге, тек билет беру мен сатылым (/kassa#key=…).
   * @param {'admin' | 'kassa'} kind
   */
  function linkCard(kind) {
    const isKassa = kind === 'kassa';
    const text = isKassa
      ? { title: t('kassa_link'), lead: t('kassa_link_lead'), qrHint: t('kassa_link_qr_hint'), confirm: t('kassa_link_new_confirm'), done: t('kassa_link_new_done') }
      : { title: t('admin_link'), lead: t('admin_link_lead'), qrHint: t('admin_link_qr_hint'), confirm: t('admin_link_new_confirm'), done: t('admin_link_new_done') };
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const base = store.info.publicUrl || (localhost && store.lanUrls[0]) || location.origin;
    const linkFor = (key) => `${base}/${isKassa ? 'kassa' : 'admin'}#key=${key}`;
    let key = null;
    const input = h('input', { class: 'input', readonly: true, value: '…', 'aria-label': text.title, onfocus: (e) => e.target.select() });
    const setKey = (value) => {
      key = value;
      input.value = value ? linkFor(value) : '';
    };
    secrets.then((s) => s && setKey(isKassa ? s.cashierKey : s.adminKey));

    const showQr = () =>
      key &&
      openModal({
        title: text.title,
        body: h('div', { class: 'issued' }, h('div', { class: 'qr-box' }, qrSvg(linkFor(key), { label: text.title })), h('p', { class: 'muted small' }, text.qrHint)),
      });

    const rotate = async (button) => {
      const ok = await confirmDialog({ title: t('admin_link_new'), message: text.confirm, confirmText: t('admin_link_new'), danger: true });
      if (!ok) return;
      await withBusy(button, async () => {
        try {
          const result = await api(isKassa ? '/admin/cashier-key/rotate' : '/admin/admin-key/rotate', { method: 'POST' });
          if (!isKassa) auth.token = result.token; // осы құрылғы кірген күйде қалады
          setKey(isKassa ? result.cashierKey : result.adminKey);
          toast(text.done);
        } catch (err) {
          toast(errorText(err), 'error');
        }
      });
    };

    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon(isKassa ? 'ticket' : 'key'), h('h2', null, text.title)),
      h(
        'div',
        { class: 'card-body form-grid' },
        h('p', { class: 'muted small' }, text.lead),
        input,
        h(
          'div',
          { class: 'row wrap' },
          h(
            'button',
            {
              class: 'btn btn-soft',
              type: 'button',
              onclick: async () => {
                if (key && (await copyText(linkFor(key)))) toast(t('link_copied'));
              },
            },
            icon('copy'),
            t('copy'),
          ),
          h('button', { class: 'btn btn-soft', type: 'button', onclick: showQr }, icon('qr'), t('admin_link_qr')),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: (e) => rotate(e.currentTarget) }, icon('refresh'), t('admin_link_new')),
        ),
      ),
    );
  }

  /** Төлем түрлері: Наличка, Каспий, Банк… — қосу, атын өзгерту, әдепкі ету, жою. */
  function paymentsCard() {
    const list = h('div', { class: 'list pay-list' });
    const input = h('input', { class: 'input', maxlength: '40', placeholder: t('payment_name_ph'), 'aria-label': t('payment_name_ph') });
    const addBtn = h('button', { class: 'btn btn-soft', type: 'submit' }, icon('plus'), t('add_payment'));
    let methods = [];

    async function load() {
      try {
        methods = await api('/admin/payment-methods');
        draw();
      } catch (err) {
        if (err.status !== 401) toast(errorText(err), 'error');
      }
    }

    async function change(button, fn) {
      await withBusy(button, async () => {
        try {
          await fn();
          await load();
        } catch (err) {
          toast(errorText(err), 'error');
        }
      });
    }

    function rename(method) {
      const field = h('input', { class: 'input', maxlength: '40', value: method.name, required: true, autofocus: true, 'aria-label': t('name') });
      const error = h('p', { class: 'error-text', hidden: true });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), t('save'));
      const form = h(
        'form',
        {
          class: 'form-grid',
          onsubmit: async (e) => {
            e.preventDefault();
            await withBusy(submit, async () => {
              try {
                await api(`/admin/payment-methods/${method.id}`, { method: 'PATCH', body: { name: field.value } });
                modal.close();
                toast(t('saved'));
                load();
              } catch (err) {
                error.textContent = errorText(err);
                error.hidden = false;
              }
            });
          },
        },
        h('label', { class: 'field' }, h('span', { class: 'label' }, t('name')), field),
        error,
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, t('cancel')), submit),
      );
      const modal = openModal({ title: t('rename'), body: form });
    }

    async function remove(method, button) {
      const ok = await confirmDialog({ title: t('delete'), message: t('delete_payment_confirm', { name: method.name }), confirmText: t('delete'), danger: true });
      if (ok) await change(button, () => api(`/admin/payment-methods/${method.id}`, { method: 'DELETE' }));
    }

    function draw() {
      mount(
        list,
        methods.map((method) =>
          h(
            'div',
            { class: 'pay-item' },
            h('span', { class: 'dot', style: { '--dot': paymentColor(method.id) } }),
            h('span', { class: 'pay-item-name' }, method.name),
            method.isDefault
              ? h('span', { class: 'chip chip-waiting' }, t('default_payment'))
              : h('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => change(e.currentTarget, () => api(`/admin/payment-methods/${method.id}`, { method: 'PATCH', body: { isDefault: true } })) }, t('make_default')),
            h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': `${t('rename')}: ${method.name}`, onclick: () => rename(method) }, icon('edit')),
            h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': `${t('delete')}: ${method.name}`, onclick: (e) => remove(method, e.currentTarget) }, icon('trash')),
          ),
        ),
      );
    }

    load();
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('wallet'), h('h2', null, t('payment_methods'))),
      h(
        'div',
        { class: 'card-body form-grid' },
        h('p', { class: 'muted small' }, t('payment_methods_lead')),
        list,
        h(
          'form',
          {
            class: 'row',
            onsubmit: async (e) => {
              e.preventDefault();
              if (!input.value.trim()) return input.focus();
              await change(addBtn, async () => {
                await api('/admin/payment-methods', { method: 'POST', body: { name: input.value } });
                input.value = '';
              });
            },
          },
          h('div', { style: { flex: '1', minWidth: '0' } }, input),
          addBtn,
        ),
      ),
    );
  }

  function passwordCard() {
    const field = (label, autocomplete) =>
      h('input', { class: 'input', type: 'password', autocomplete, required: true, 'aria-label': label });
    const current = field(t('current_password'), 'current-password');
    const next = field(t('new_password'), 'new-password');
    const repeat = field(t('repeat_password'), 'new-password');
    const error = h('p', { class: 'error-text', hidden: true });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('lock'), t('change'));
    const form = h(
      'form',
      {
        class: 'card-body form-grid',
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          if (next.value.length < 4) return showError(t('weak_password'));
          if (next.value !== repeat.value) return showError(t('passwords_mismatch'));
          await withBusy(button, async () => {
            try {
              const result = await api('/admin/password', { method: 'POST', body: { current: current.value, next: next.value } });
              auth.token = result.token;
              store.passwordIsDefault = false;
              form.reset();
              toast(t('password_changed'));
              refreshShell();
            } catch (err) {
              showError(errorText(err));
            }
          });
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('current_password')), current),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('new_password')), next),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('repeat_password')), repeat),
      error,
      h('div', null, button),
    );
    function showError(message) {
      error.textContent = message;
      error.hidden = false;
    }
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('lock'), h('h2', null, t('change_password'))),
      store.passwordIsDefault && h('div', { style: { padding: '14px 20px 0' } }, h('div', { class: 'notice' }, icon('alert'), t('default_password_warning'))),
      form,
    );
  }

  function screensCard() {
    const installSlot = h('div');
    const drawInstall = () => {
      let content = null;
      if (isStandalone()) content = h('p', { class: 'hint' }, `✓ ${t('installed')}`);
      else if (canPromptInstall())
        content = h('button', { class: 'btn btn-soft', onclick: () => promptInstall() }, icon('download'), t('install_app'));
      else if (isIos()) content = h('p', { class: 'hint' }, t('ios_install_hint'));
      else content = h('p', { class: 'hint' }, t('install_hint'));
      mount(installSlot, content);
    };
    drawInstall();
    unsubscribe = onInstallChange(drawInstall);

    const linkRow = (href, iconName, title, hint) =>
      h(
        'a',
        env.artifact
          ? { class: 'list-item', href, 'data-link': true, style: { color: 'inherit', textDecoration: 'none' } }
          : { class: 'list-item', href, target: '_blank', rel: 'noopener', style: { color: 'inherit', textDecoration: 'none' } },
        h('div', { class: 'empty-icon', style: { width: '44px', height: '44px', borderRadius: '14px' } }, icon(iconName)),
        h('div', { class: 'qbody' }, h('div', { style: { fontWeight: '650' } }, title), h('div', { class: 'qmeta' }, hint)),
        icon(env.artifact ? 'chevronRight' : 'external', 'icon faint'),
      );

    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('monitor'), h('h2', null, env.artifact ? t('screens_only') : t('screens'))),
      h(
        'div',
        { class: 'list', style: { padding: '10px 0 0' } },
        linkRow('/board', 'monitor', t('open_board'), t('open_board_hint')),
        linkRow('/', 'phone', t('open_client'), t('open_client_hint')),
      ),
      !env.artifact &&
        h(
          'div',
          { class: 'card-body', style: { borderTop: '1px solid var(--line)' } },
          h('div', { class: 'row wrap' }, h('div', { class: 'spacer' }, h('div', { style: { fontWeight: '650' } }, t('install_app')), installSlot)),
        ),
    );
  }

  function accountCard() {
    return h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-body row wrap', style: { paddingTop: '18px' } },
        h('span', { class: 'label' }, t('language')),
        langToggle(),
        h('div', { class: 'spacer' }),
        !env.artifact && h('button', { class: 'btn btn-danger', onclick: onLogout }, icon('logout'), t('logout')),
      ),
    );
  }

  let unsubscribe = () => {};
  mount(
    el,
    pageHead(t('settings'), env.artifact ? t('settings_lead_artifact') : t('settings_lead')),
    h(
      'div',
      { class: 'report-grid' },
      h('div', { class: 'stack' }, businessCard(), !env.artifact && paymentsCard(), screensCard()),
      // Claude сілтемесінде кіру Claude аккаунты арқылы — құпиясөз де, сілтемелер де керек емес
      h('div', { class: 'stack' }, !env.artifact && linkCard('kassa'), !env.artifact && linkCard('admin'), !env.artifact && passwordCard(), accountCard()),
    ),
  );

  return {
    el,
    destroy() {
      unsubscribe();
    },
  };
}
