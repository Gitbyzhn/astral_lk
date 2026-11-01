import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { time } from '../core/format.js';
import { audioReady, chime, unlockAudio } from '../core/media.js';
import { brand, langToggle } from '../core/ui.js';

/** Залдағы теледидарға арналған табло: қазір шақырылған нөмір және келесі кезек. */
export function boardPage({ info }) {
  const el = h('div', { class: 'board' });
  const clock = h('div', { class: 'board-clock' });
  let data = null;
  let online = true;
  let lastServing = null;
  let soundOn = audioReady();

  const tick = () => (clock.textContent = time(new Date().toISOString()));
  tick();
  const clockTimer = setInterval(tick, 5000);

  async function load() {
    try {
      const next = await api('/public/board');
      const serving = next.serving.map((s) => `${s.number}:${s.calledAt}`).join(',');
      const isNewCall = lastServing !== null && serving !== lastServing && next.serving.length > 0;
      lastServing = serving;
      data = next;
      render(isNewCall);
      if (isNewCall && soundOn) chime();
    } catch {
      /* желі қалпына келгенде қайта сұралады */
    }
  }

  function enableSound() {
    unlockAudio();
    soundOn = true;
    chime();
    render(false);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function render(flash) {
    if (!data) return;
    const current = data.serving.at(-1);
    const number = h('div', { class: ['now-number', flash && 'flash'] }, current ? `№${current.number}` : '—');

    mount(
      el,
      h(
        'header',
        { class: 'board-head' },
        brand(info.businessName),
        clock,
        h('div', { class: 'row', style: { gap: '8px' } }, langToggle(), h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Fullscreen', title: 'Fullscreen', onclick: toggleFullscreen }, icon('maximize'))),
      ),
      h(
        'main',
        { class: 'board-main' },
        h(
          'section',
          { class: 'card board-now', 'aria-live': 'assertive' },
          h('div', { class: 'issued-label' }, t('board_now')),
          number,
          h('div', { class: 'muted', style: { fontSize: 'clamp(16px, 2vw, 28px)', fontWeight: '650' } }, current ? t('please_come') : t('nobody_called')),
        ),
        h(
          'section',
          { class: 'card board-next' },
          h('h2', null, t('board_next')),
          data.next.length
            ? h('div', { class: 'board-next-grid' }, data.next.map((item) => h('div', null, String(item.number))))
            : h('p', { class: 'faint', style: { fontSize: 'clamp(16px, 1.8vw, 24px)' } }, t('board_empty')),
          h(
            'div',
            { class: 'board-foot' },
            h('span', null, t('board_waiting', { n: data.waiting })),
            h('span', { class: ['live', online && 'on'] }, online ? t('live') : t('offline')),
            h('div', { class: 'spacer' }),
            soundOn
              ? h('span', { class: 'live on' }, t('sound_on'))
              : h('button', { class: 'btn btn-soft btn-sm', onclick: enableSound }, icon('volume', 'icon icon-sm'), t('enable_sound')),
          ),
        ),
      ),
    );
  }

  load();

  return {
    el,
    onEvent(type) {
      if (type === 'queue' || type === 'resync') load();
    },
    setOnline(value) {
      online = value;
      render(false);
    },
    destroy() {
      clearInterval(clockTimer);
    },
  };
}
