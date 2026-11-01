// HTTP көмекшілері: JSON жауап, қауіпсіздік тақырыптары, қателер (сервер нұсқасымен бірдей пішін).
import { HttpError } from '../server/errors.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
};

export function json(data, status = 200, extra = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    const extra = err.details?.retryAfter ? { 'Retry-After': String(err.details.retryAfter) } : {};
    return json({ error: err.code, ...err.details }, err.status, extra);
  }
  if (err instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
  console.error(err);
  return json({ error: 'server_error' }, 500);
}

/** Сұраудың JSON денесі (бос болса — {}). */
export async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 32_768) throw new HttpError(413, 'too_large');
  return JSON.parse(text);
}

/** Қатарларды ретпен салыстыру (уақыт бойынша ағып кетпейтін). */
export function constantTimeEqual(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Біркелкі кездейсоқ жол (rejection sampling). */
export function randomString(length, alphabet) {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}
