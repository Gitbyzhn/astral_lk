import { onLangChange } from '../core/i18n.js';
import { createRouter } from '../core/router.js';
import { CLIENT_ROUTES, createClientApp } from './app.js';

const app = createClientApp({ root: document.getElementById('app') });
const router = createRouter(CLIENT_ROUTES, ({ route, params }) => app.show(route, params));

onLangChange(() => app.rerender());
router.resolve();
app.start();
