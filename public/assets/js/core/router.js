/**
 * History API негізіндегі шағын маршрутизатор.
 *   createRouter([{ path: '/t/:code', render }], onRoute)
 * `data-link` атрибуты бар <a> сілтемелері бетті қайта жүктемей ашылады.
 */
export function createRouter(routes, onRoute) {
  const compiled = routes.map((route) => {
    if (route.path === '*') return { ...route, keys: [], regex: null };
    const keys = [];
    const pattern = route.path
      .replace(/\/+$/, '')
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      });
    return { ...route, keys, regex: new RegExp(`^${pattern || ''}/?$`) };
  });

  function match(pathname) {
    for (const route of compiled) {
      const m = route.regex?.exec(pathname);
      if (m) {
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { route, params };
      }
    }
    return { route: compiled.find((r) => r.path === '*'), params: {} };
  }

  const resolve = () => onRoute(match(location.pathname));

  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', resolve);

  function navigate(path, { replace = false } = {}) {
    if (path === location.pathname + location.search) return resolve();
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    window.scrollTo(0, 0);
    resolve();
  }

  return { navigate, resolve, match };
}
