// Әкімші және касса сілтемелерін көрсету:   npm run admin-link
// Әкімші сілтемесін жаңарту (ескісі өшеді):   npm run admin-link -- --new
// Касса сілтемесін жаңарту (ескісі өшеді):    npm run admin-link -- --new-kassa
import { config } from '../config.js';
import { openDatabase } from '../db.js';
import { createSettings } from '../services/settings.js';
import { generateAdminKey } from '../auth.js';

const db = openDatabase();
const settings = createSettings(db);
const bump = (key) => settings.set(key, String(Number(settings.get(key, '1')) + 1));

if (process.argv.includes('--new') || !settings.get('admin_key')) {
  settings.set('admin_key', generateAdminKey());
  bump('password_version');
  console.log('✓ Жаңа әкімші сілтемесі жасалды — ескі сілтеме енді жұмыс істемейді.');
}
if (process.argv.includes('--new-kassa') || !settings.get('cashier_key')) {
  settings.set('cashier_key', generateAdminKey());
  bump('cashier_version');
  console.log('✓ Жаңа касса сілтемесі жасалды — ескі сілтеме енді жұмыс істемейді.');
}
const base = config.publicUrl || `http://localhost:${config.port}`;
console.log(`Әкімші: ${base}/admin#key=${settings.get('admin_key')}`);
console.log(`Касса:  ${base}/kassa#key=${settings.get('cashier_key')}`);
db.close();
