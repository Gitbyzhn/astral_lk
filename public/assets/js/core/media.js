import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { dateTime, money } from './format.js';
import { qrSvg } from './qr.js';

/* ------------------------------- Дыбыс ------------------------------- */
let audioCtx = null;

/** Браузерлер дыбысты тек пайдаланушы басқаннан кейін рұқсат етеді — сол сәтте шақырыңыз. */
export function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return true;
  } catch {
    return false;
  }
}

export const audioReady = () => audioCtx?.state === 'running';

/** Жағымды үш нотадан тұратын «дың-дың» белгісі. */
export function chime() {
  if (!audioCtx) return;
  const start = audioCtx.currentTime + 0.02;
  [
    [784, 0],
    [1047, 0.16],
    [1319, 0.32],
  ].forEach(([freq, offset]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.4, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.6);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start + offset);
    osc.stop(start + offset + 0.65);
  });
}

export function vibrate(pattern = [300, 120, 300, 120, 600]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* қолдау жоқ */
  }
}

/* ---------------------------- Басып шығару ---------------------------- */

/** Талонды чек принтерге (58/80 мм) немесе қарапайым принтерге шығарады. */
export function printTicket({ businessName, order, url }) {
  let area = document.getElementById('print-area');
  if (!area) {
    area = h('div', { id: 'print-area' });
    document.body.append(area);
  }
  mount(
    area,
    h('div', { class: 'p-biz' }, businessName),
    h('div', { class: 'p-label' }, t('queue_number')),
    h('div', { class: 'p-number' }, `№${order.number}`),
    qrSvg(url, { margin: 2, dark: '#000' }),
    h(
      'table',
      null,
      h(
        'tbody',
        null,
        order.items.map((item) =>
          h('tr', null, h('td', null, `${item.name} ×${item.qty}`), h('td', { class: 'r' }, money(item.qty * item.price))),
        ),
        h(
          'tr',
          { class: 'p-total' },
          h('td', null, `${t('total')} · ${t('people_count', { n: order.people })}`),
          h('td', { class: 'r' }, money(order.total)),
        ),
      ),
    ),
    h('div', { class: 'p-foot' }, dateTime(order.createdAt)),
    h('div', { class: 'p-foot' }, t('scan_hint')),
  );
  window.print();
}
