import { h } from '../core/dom.js';
import { brand, langToggle } from '../core/ui.js';

/** Клиент беттерінің жоғарғы жолағы: логотип (басты бетке сілтеме) және тіл ауыстырғышы. */
export function clientHeader(info) {
  return h(
    'header',
    { class: 'client-head' },
    h('a', { href: '/', 'data-link': true, class: 'brand-link' }, brand(info.businessName)),
    langToggle(),
  );
}
