import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Барлық баптаулар орта айнымалылары (environment variables) арқылы беріледі.
 * Әдепкі мәндер шағын бизнеске бірден жарайтындай таңдалған.
 */
export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  /** SQLite файлы сақталатын бума. */
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data')),
  /** Күн/ай есептері мен кезек нөмірінің күнделікті нөлденуі осы уақыт белдеуімен есептеледі. */
  timeZone: process.env.APP_TIMEZONE || 'Asia/Almaty',
  /** Алғашқы іске қосудағы әкімші құпиясөзі (кейін «Баптаулар» бетінде өзгертіледі). */
  initialPassword: process.env.ADMIN_PASSWORD || 'admin',
  /** Осынша сағаттан ескі, қызмет көрсетілмеген талондар кезектен автоматты түрде жабылады. */
  queueTtlHours: int(process.env.QUEUE_TTL_HOURS, 12),
  /** Кіру токенінің жарамдылық мерзімі (күн). */
  sessionDays: int(process.env.SESSION_DAYS, 30),
  /** QR сілтемелерінің негізгі мекенжайы, мысалы https://kezek.example.kz (бос болса — браузердегі мекенжай). */
  publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null,
  /** Reverse proxy (nginx, Docker) артында дұрыс IP алу үшін. */
  trustProxy: process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
};
