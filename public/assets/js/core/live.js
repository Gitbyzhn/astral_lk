/**
 * Нақты уақыттағы жаңартулар (Server-Sent Events).
 * Байланыс үзілсе — өзі қайта қосылады; телефон экраны қайта ашылғанда бірден жаңартады;
 * қосымша сақтық үшін әр 20 секунд сайын да сұрайды.
 *
 * @param {(type: 'queue' | 'types' | 'settings' | 'resync') => void} onEvent
 * @param {{ onStatus?: (online: boolean) => void, pollMs?: number }} [options]
 */
export function connectLive(onEvent, { onStatus = () => {}, pollMs = 20_000 } = {}) {
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
