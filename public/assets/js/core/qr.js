import qrcode from '/vendor/qrcode.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * QR кодты SVG ретінде салады: ақ фонда қою көк модульдер — кез келген камера оқиды.
 * @param {string} text
 * @param {{ margin?: number, dark?: string, light?: string, label?: string }} [options]
 */
export function qrSvg(text, { margin = 4, dark = '#0b1530', light = '#ffffff', label = 'QR' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + margin * 2;

  // Әр жолдағы қатар тұрған модульдерді бір тіктөртбұрышқа біріктіреміз — SVG жеңіл болады.
  let d = '';
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col++;
      d += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', light);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', dark);
  svg.append(bg, path);
  return svg;
}
