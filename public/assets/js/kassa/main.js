// Касса кабинеті (/kassa): кассир тек билет береді және сатылымды көреді.
// Кіру — әкімші берген касса сілтемесі арқылы (/kassa#key=…), аккаунтсыз.
import { auth } from '../core/api.js';
import { onLangChange, t } from '../core/i18n.js';
import { createRouter } from '../core/router.js';
import { createAdminApp } from '../admin/app.js';
import { cashierPage } from '../admin/cashier.js';
import { kassaLoginView } from './login.js';
import { salesPage } from './sales.js';

auth.use('kassa');

const KASSA_NAV = [
  { path: '/kassa', icon: 'ticket', label: () => t('cashier'), page: cashierPage },
  { path: '/kassa/sales', icon: 'receipt', label: () => t('sales'), page: salesPage },
];

const app = createAdminApp({
  root: document.getElementById('app'),
  navigate: (path, opts) => router.navigate(path, opts),
  nav: KASSA_NAV,
  role: 'cashier',
  login: kassaLoginView,
});

const router = createRouter([...KASSA_NAV.map((item) => ({ path: item.path, item })), { path: '*' }], ({ route }) => {
  if (!route?.item) return router.navigate('/kassa', { replace: true });
  app.show(route.item);
});

onLangChange(() => app.rerender());
router.resolve();
app.start();
