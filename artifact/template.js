// Беттің толық HTML құжаты. Құрастыру скрипті (Node) де, бет өзі де (жариялағанда) осыны қолданады:
// стиль мен скрипт мәтіні өзгермейді, тек клиенттерге арналған күй (JSON) жаңарады.
const CLOSE_SCRIPT = '</' + 'script>';
const CLOSE_STYLE = '</' + 'style>';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** JSON-ды <script> ішіне қауіпсіз салу (</script> және U+2028/2029 жолдарынан қорғау). */
export const safeJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

export function renderDocument({ css, js, state, title }) {
  return [
    '<!DOCTYPE html>',
    '<html lang="kk">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    `<title>${escapeHtml(title)}</title>`,
    `<style id="astral-css">${css}${CLOSE_STYLE}`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script id="astral-public" type="application/json">${safeJson(state)}${CLOSE_SCRIPT}`,
    `<script id="astral-app">${js}${CLOSE_SCRIPT}`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
