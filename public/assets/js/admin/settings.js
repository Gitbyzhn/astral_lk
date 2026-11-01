import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api, auth } from '../core/api.js';
import { canPromptInstall, isIos, isStandalone, onInstallChange, promptInstall } from '../core/pwa.js';
import { langToggle, toast, withBusy } from '../core/ui.js';
import { pageHead, store } from './shared.js';
import { env } from '../core/env.js';

/** Баптаулар: мекеме атауы, құпиясөз, табло/клиент беті, қосымшаны орнату, тіл. */
export function settingsPage({ onLogout, refreshShell }) {
  const el = h('div', { class: 'page' });

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
      h('div', { class: 'stack' }, businessCard(), screensCard()),
      // Claude сілтемесінде кіру Claude аккаунты арқылы — құпиясөз керек емес
      h('div', { class: 'stack' }, !env.artifact && passwordCard(), accountCard()),
    ),
  );

  return {
    el,
    destroy() {
      unsubscribe();
    },
  };
}
