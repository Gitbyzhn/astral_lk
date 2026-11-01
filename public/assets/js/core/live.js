/**
 * Нақты уақыттағы жаңартулар.
 *  • 'sse'  (өз сервері): Server-Sent Events — өзгеріс болған сәтте хабар келеді;
 *  • 'poll' (Cloudflare, тегін хостинг): әр 10 секунд сайын /api/public/version тексеріледі,
 *    өзгеріс болса ғана деректер қайта жүктеледі.
 * Екеуінде де телефон экраны қайта ашылғанда бірден жаңартады.
 *
 * @param {(type: 'queue' | 'types' | 'settings' | 'resync') => void} onEvent
 * @param {{ onStatus?: (online: boolean) => void, mode?: 'sse' | 'poll', pollMs?: number }} [options]
 */
export function connectLive(onEvent, { onStatus = () => {}, mode = 'sse', pollMs } = {}) {
  return mode === 'poll' ? connectPoll(onEvent, onStatus, pollMs ?? 10_000) : connectSse(onEvent, onStatus, pollMs ?? 20_000);
}

function connectPoll(onEvent, onStatus, pollMs) {
  let last = null;
  let busy = false;
  let stopped = false;

  async function check() {
    if (busy || stopped) return;
    busy = true;
    try {
      const res = await fetch('/api/public/version', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const v = await res.json();
      onStatus(true);
      if (!last) onEvent('resync');
      else {
        if (v.queue !== last.queue) onEvent('queue');
        if (v.types !== last.types) onEvent('types');
        if (v.settings !== last.settings) onEvent('settings');
      }
      last = v;
    } catch {
      onStatus(false);
    } finally {
      busy = false;
    }
  }

  const onVisible = () => document.visibilityState === 'visible' && check();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', check);
  const timer = setInterval(() => document.visibilityState === 'visible' && check(), pollMs);
  check();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', check);
  };
}

function connectSse(onEvent, onStatus, pollMs) {
  let source = null;
  let closed = false;
  let reconnectTimer = null;

  function open() {
    if (closed) return;
    source?.close();
    source = new EventSource('/api/events');
    source.addEventListener('hello', () => {
      onStatus(true);
      onEvent('resync');
    });
    for (const type of ['queue', 'types', 'settings']) source.addEventListener(type, () => onEvent(type));
    source.onerror = () => {
      onStatus(false);
      if (source.readyState === EventSource.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(open, 4000);
      }
    };
  }

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (!source || source.readyState === EventSource.CLOSED) open();
    onEvent('resync');
  };
  const onOnline = () => open();

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  // Қосымша сақтық: SSE үнсіз үзілсе де деректер ескірмейді
  const poll = setInterval(() => {
    if (document.visibilityState === 'visible') onEvent('resync');
  }, pollMs);

  open();

  return () => {
    closed = true;
    clearInterval(poll);
    clearTimeout(reconnectTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    source?.close();
  };
}
