// Әкімші сілтемесін көрсету:      npm run admin-link
// Жаңасын жасау (ескісі өшеді):   npm run admin-link -- --new
import { config } from '../config.js';
import { openDatabase } from '../db.js';
import { createSettings } from '../services/settings.js';
import { generateAdminKey } from '../auth.js';

const db = openDatabase();
const settings = createSettings(db);
if (process.argv.includes('--new') || !settings.get('admin_key')) {
  settings.set('admin_key', generateAdminKey());
  settings.set('password_version', String(Number(settings.get('password_version', '1')) + 1));
  console.log('✓ Жаңа әкімші сілтемесі жасалды — ескі сілтеме енді жұмыс істемейді.');
}
const base = config.publicUrl || `http://localhost:${config.port}`;
console.log(`${base}/admin#key=${settings.get('admin_key')}`);
db.close();
