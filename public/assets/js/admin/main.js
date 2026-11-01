import { onLangChange } from '../core/i18n.js';
import { createRouter } from '../core/router.js';
import { ADMIN_NAV, createAdminApp } from './app.js';

const app = createAdminApp({
  root: document.getElementById('app'),
  navigate: (path, opts) => router.navigate(path, opts),
});

const router = createRouter([...ADMIN_NAV.map((item) => ({ path: item.path, item })), { path: '*' }], ({ route }) => {
  if (!route?.item) return router.navigate('/admin', { replace: true });
  app.show(route.item);
});

onLangChange(() => app.rerender());
router.resolve();
app.start();
