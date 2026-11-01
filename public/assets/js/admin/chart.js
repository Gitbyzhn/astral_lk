import { h } from '../core/dom.js';
import { compact } from '../core/format.js';

/** «Әдемі» қадам: 1, 2, 2.5, 5 × 10ⁿ */
function niceStep(raw) {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/**
 * Бір сериялы бағаналы график (түсім). Әр бағана — өз tooltip-і бар нысана (hover + пернетақта).
 * Бір серия болғандықтан аңыз (legend) жоқ — тақырып не көрсетілгенін айтады.
 *
 * @param {{
 *   points: { key: string, value: number }[],
 *   label: (key: string) => string,          // ось белгісі
 *   showLabel: (index: number, total: number) => boolean,
 *   tooltip: (point: any) => Node,           // tooltip мазмұны
 *   format?: (v: number) => string,
 *   ariaLabel: string,
 * }} options
 */
export function columnChart({ points, label, showLabel, tooltip, format = compact, ariaLabel }) {
  const max = Math.max(0, ...points.map((p) => p.value));
  const step = niceStep(max / 4);
  const top = Math.max(step * 4, step * Math.ceil(max / step));
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);

  const tip = h('div', { class: 'tooltip', hidden: true, role: 'tooltip' });
  const plot = h(
    'div',
    { class: 'chart-plot' },
    h(
      'div',
      { class: 'chart-grid', 'aria-hidden': 'true' },
      ticks.map((v, i) =>
        h('div', { class: ['gl', i === 0 && 'base'], style: { bottom: `${(v / top) * 100}%` } }, h('span', null, format(v))),
      ),
    ),
  );

  const bars = h('div', { class: 'chart-bars' });
  points.forEach((point, index) => {
    const pct = top ? (point.value / top) * 100 : 0;
    const col = h(
      'div',
      { class: 'chart-col', tabindex: '0', 'aria-label': `${label(point.key)}: ${point.value}` },
      h('div', { class: ['bar', point.value === 0 && 'zero'], style: { height: `${pct}%` } }),
    );
    const show = () => {
      tip.replaceChildren(tooltip(point));
      tip.hidden = false;
      const plotBox = plot.getBoundingClientRect();
      const colBox = col.getBoundingClientRect();
      const barTop = colBox.bottom - (colBox.height * pct) / 100;
      let x = colBox.left + colBox.width / 2 - plotBox.left;
      const half = tip.offsetWidth / 2;
      x = Math.max(half - 44, Math.min(plotBox.width - half, x));
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.max(barTop - plotBox.top, 24)}px`;
    };
    const hide = () => (tip.hidden = true);
    col.addEventListener('pointerenter', show);
    col.addEventListener('pointerleave', hide);
    col.addEventListener('focus', show);
    col.addEventListener('blur', hide);
    bars.append(col);
  });
  plot.append(bars, tip);

  const axis = h(
    'div',
    { class: 'chart-x', 'aria-hidden': 'true' },
    points.map((point, i) => h('span', null, showLabel(i, points.length) ? label(point.key) : '')),
  );

  return h('figure', { class: 'chart', role: 'group', 'aria-label': ariaLabel, style: { margin: '0' } }, plot, axis);
}
