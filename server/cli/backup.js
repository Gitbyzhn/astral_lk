// Деректер базасының сақтық көшірмесі (сервер жұмыс істеп тұрғанда да қауіпсіз):
//   npm run backup                 → data/backups/astral-2026-11-01-1530.db
//   npm run backup -- /path/to.db  → көрсетілген файлға
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openDatabase } from '../db.js';

const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const target = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups', `astral-${stamp}.db`));
fs.mkdirSync(path.dirname(target), { recursive: true });

const db = openDatabase();
await db.backup(target);
db.close();
console.log(`✓ Сақтық көшірме: ${target}`);
