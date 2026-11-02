// Web Push (клиент телефонына хабарлама) — өз сервер нұсқасы да, Cloudflare нұсқасы да қолданады.
// Хабарламаның ішінде мәтін жоқ («бос» push): телефондағы service worker оны алғанда
// /api/public/push/pending арқылы қай талон шақырылғанын сұрап, хабарламаны өзі көрсетеді.
// Сондықтан шифрлау керек емес — тек VAPID қолтаңбасы (ES256, WebCrypto).

const enc = new TextEncoder();

export const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const fromB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** Браузерлердің push қызметтері: Chrome/Android/Samsung/Opera (FCM), Firefox, Safari/iPhone, Edge. */
export const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

/**
 * Push мекенжайын тексеру: тек белгілі push қызметтеріне (басқа серверлерге сұрау жібертпеу үшін).
 * @returns {string | null}
 */
export function validEndpoint(value, { hosts = PUSH_HOSTS, allowInsecure = false } = {}) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) return null;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? url.href : null;
}

/** Жаңа VAPID кілттері (WebCrypto): ашық кілт — браузерге, жеке кілт (JWK) — серверде. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
  return { publicKey, privateJwk };
}

const keyCache = new Map();
function signingKey(privateJwk) {
  if (!keyCache.has(privateJwk)) {
    const jwk = JSON.parse(privateJwk);
    keyCache.set(
      privateJwk,
      crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
    );
  }
  return keyCache.get(privateJwk);
}

/** VAPID JWT (ES256): push қызметі хабарламаның осы серверден екенін тексереді. */
export async function vapidJwt({ endpoint, privateJwk, subject, now = Date.now() }) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(privateJwk), enc.encode(data));
  return `${data}.${b64url(signature)}`;
}

/** VAPID `sub`: https сайт мекенжайы, болмаса mailto (Apple тек осы екеуін қабылдайды). */
export const vapidSubject = (origin) => (/^https:\/\//.test(origin ?? '') ? origin : 'mailto:queue@astral-labyrinth.invalid');

/**
 * Бір құрылғыға «бос» push жіберу.
 * @returns {Promise<{ ok: boolean, gone: boolean, status: number }>} gone — жазылым ескірген, өшіру керек
 */
export async function sendPush({ endpoint, publicKey, privateJwk, subject, ttl = 3600 }) {
  try {
    const jwt = await vapidJwt({ endpoint, privateJwk, subject });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { TTL: String(ttl), Urgency: 'high', Authorization: `vapid t=${jwt}, k=${publicKey}` },
      body: new Uint8Array(0),
    });
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: 0 };
  }
}

/** Хабарлама тілі: kk немесе ru. */
export const pushLang = (value) => (value === 'ru' ? 'ru' : 'kk');
