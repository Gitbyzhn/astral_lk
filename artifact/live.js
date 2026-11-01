/**
 * Нақты уақыттағы жаңартулар: әкімшіде — Claude деректер базасының өзгерістері (onSnapshot).
 * Клиентте байланыс жоқ: кезек өзгергенде бет жаңа нұсқаға өздігінен қайта жүктеледі.
 */
import { runtime } from './runtime.js';
import { onData } from './store.js';

export function connectLive(onEvent, { onStatus = () => {} } = {}) {
  onStatus(true);
  if (!runtime.db) return () => {};
  return onData((type) => {
    if (type === 'error') onStatus(false);
    else onEvent(type);
  });
}
