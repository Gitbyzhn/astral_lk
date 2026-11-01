/**
 * Claude сілтемесіне арналған маршрутизатор: тек #атау (латын әріп, сан, сызықша) жұмыс істейді.
 * Интерфейсі core/router.js-пен бірдей, беттер ішкі жолдарды (/admin/queue) қолдана береді.
 */
const NAMES = [
  ['/admin', 'cashier'],
  ['/admin/queue', 'queue'],
  ['/admin/types', 'types'],
  ['/admin/reports', 'reports'],
  ['/admin/settings', 'setup'],
  ['/board', 'board'],
  ['/', 'home'],
];

export function pathToHash(path) {
  const [pathname, query = ''] = String(path).split('?');
  if (pathname.startsWith('/t/')) return `#t-${pathname.slice(3)}`;
  if (pathname === '/admin/types' && /(^|&)new=/.test(query)) return '#types-new';
  const hit = NAMES.find(([p]) => p === pathname);
  return hit ? `#${hit[1]}` : '#home';
}

export function hashToPath(hash) {
  const name = String(hash || '').replace(/^#/, '');
  if (!name) return '/';
  if (name.startsWith('t-')) return `/t/${name.slice(2)}`;
  if (name === 'types-new') return '/admin/types';
  const hit = NAMES.find(([, n]) => n === name);
  return hit ? hit[0] : '/__unknown';
}

export function createRouter(routes, onRoute) {
  const compiled = routes.map((route) => {
    if (route.path === '*') return { ...route, keys: [], regex: null };
    const keys = [];
    const pattern = route.path.replace(/\/+$/, '').replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    return { ...route, keys, regex: new RegExp(`^${pattern || ''}/?$`) };
  });

  function match(pathname) {
    for (const route of compiled) {
      const m = route.regex?.exec(pathname);
      if (m) return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return { route: compiled.find((r) => r.path === '*'), params: {} };
  }

  const resolve = () => onRoute({ ...match(hashToPath(location.hash)), hash: location.hash });

  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('hashchange', resolve);

  function navigate(path, { replace = false } = {}) {
    const hash = pathToHash(path);
    if (hash === location.hash) return resolve();
    if (replace) {
      try {
        history.replaceState(null, '', hash);
        resolve();
      } catch {
        location.replace(hash); // sandbox iframe-та history API бұғатталса
      }
    } else {
      location.hash = hash;
    }
    window.scrollTo(0, 0);
  }

  return { navigate, resolve, match };
}
