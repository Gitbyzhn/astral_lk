import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api, auth } from '../core/api.js';
import { brandHero, langToggle, withBusy } from '../core/ui.js';
import { store } from './shared.js';

/** Әкімші кіру беті. */
export function loginView({ onSuccess, error: initialError = null }) {
  const input = h('input', {
    class: 'input',
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
    autofocus: true,
    placeholder: '••••••',
    'aria-label': t('password'),
  });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: !initialError }, initialError ? errorText(initialError) : '');
  const button = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, t('login_btn'), icon('arrowRight'));

  const form = h(
    'form',
    {
      class: 'form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        input.removeAttribute('aria-invalid');
        if (!input.value) return input.focus();
        await withBusy(button, async () => {
          try {
            const result = await api('/auth/login', { method: 'POST', body: { password: input.value } });
            auth.token = result.token;
            store.passwordIsDefault = result.passwordIsDefault;
            store.lanUrls = (await api('/admin/session').catch(() => ({}))).lanUrls ?? [];
            onSuccess();
          } catch (err) {
            error.textContent = errorText(err);
            error.hidden = false;
            input.setAttribute('aria-invalid', 'true');
            input.select();
          }
        });
      },
    },
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('password')), input),
    error,
    button,
  );

  const view = h(
    'div',
    { class: 'auth' },
    h(
      'div',
      { class: 'card auth-card' },
      brandHero(store.info.businessName),
      h('h1', null, t('login_title')),
      h('p', { class: 'lead' }, t('login_lead')),
      form,
      h('div', { class: 'auth-lang' }, langToggle()),
    ),
  );
  requestAnimationFrame(() => input.focus());
  return view;
}
