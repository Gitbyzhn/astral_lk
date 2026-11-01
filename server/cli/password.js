// Құпиясөзді ұмытып қалсаңыз:  npm run password -- ЖаңаҚұпиясөз
import { openDatabase } from '../db.js';
import { createSettings } from '../services/settings.js';
import { PASSWORD_LIMITS, hashPassword } from '../auth.js';

const next = process.argv[2];
if (!next || next.length < PASSWORD_LIMITS.min || next.length > PASSWORD_LIMITS.max) {
  console.error(`Қолданылуы: npm run password -- <жаңа құпиясөз, кемінде ${PASSWORD_LIMITS.min} таңба>`);
  process.exit(1);
}

const db = openDatabase();
const settings = createSettings(db);
settings.set('admin_password', hashPassword(next));
settings.set('password_version', String(Number(settings.get('password_version', '1')) + 1));
settings.set('password_is_default', '0');
db.close();
console.log('✓ Әкімші құпиясөзі өзгертілді. Барлық құрылғылардан қайта кіру қажет.');
