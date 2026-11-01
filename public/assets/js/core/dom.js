/**
 * Кішкентай DOM көмекшісі. Мәтін әрқашан textContent арқылы қойылады (XSS қауіпсіз).
 *
 *   h('button', { class: 'btn', onclick: fn }, 'Мәтін', icon('plus'))
 *
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (key === 'style') {
        for (const [prop, v] of Object.entries(value)) {
          if (v == null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
          else el.style[prop] = v;
        }
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'ref' && typeof value === 'function') value(el);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

/** Балаларды қосады: жолдар, сандар, түйіндер, массивтер, null елемейді. */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Элементтің ішін ауыстырады. */
export function mount(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

export const $ = (selector, root = document) => root.querySelector(selector);
