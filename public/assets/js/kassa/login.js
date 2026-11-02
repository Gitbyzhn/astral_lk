import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { api, auth } from '../core/api.js';
import { brandHero, langToggle, withBusy } from '../core/ui.js';
import { store } from '../admin/shared.js';

/** Сілтемеден немесе жай кілттен кілтті алу: https://…/kassa#key=AbC… → AbC… */
function extractKey(value) {
  const text = value.trim();
  const match = /[#&?]key=([A-Za-z0-9]+)/.exec(text);
  if (match) return match[1];
  return /^[A-Za-z0-9]{16,64}$/.test(text) ? text : null;
}

const linkError = (err) => (err?.code === 'invalid_admin_link' ? t('invalid_kassa_link') : errorText(err));

/**
 * Касса кіру беті. Әдетте кассир әкімші жіберген сілтемені ашады да, бірден кіреді.
 * iPhone-да басты экранға қосылған қосымшаның жады бөлек — сол үшін сілтемені осында қоюға болады.
 */
export function kassaLoginView({ onSuccess, error: initialError = null }) {
  const input = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    required: true,
    placeholder: 'https://…/kassa#key=…',
    'aria-label': t('kassa_link_input'),
  });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: !initialError }, initialError ? linkError(initialError) : '');
  const button = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, t('login_btn'), icon('arrowRight'));

  const form = h(
    'form',
    {
      class: 'form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        input.removeAttribute('aria-invalid');
        const key = extractKey(input.value);
        if (!key) {
          error.textContent = t('invalid_kassa_link');
          error.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          return input.focus();
        }
        await withBusy(button, async () => {
          try {
            const result = await api('/auth/key', { method: 'POST', body: { key } });
            auth.token = result.token;
            onSuccess();
          } catch (err) {
            error.textContent = linkError(err);
            error.hidden = false;
            input.setAttribute('aria-invalid', 'true');
            input.select();
          }
        });
      },
    },
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('kassa_link_input')), input),
    error,
    button,
  );

  return h(
    'div',
    { class: 'auth' },
    h(
      'div',
      { class: 'card auth-card' },
      brandHero(store.info.businessName),
      h('h1', null, t('kassa_panel')),
      h('p', { class: 'lead' }, t('kassa_login_lead')),
      form,
      h('div', { class: 'auth-lang' }, langToggle()),
    ),
  );
}
