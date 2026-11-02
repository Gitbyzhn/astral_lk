// Әкімші мен касса қосымшалары кіру токенін бөлек сақтайды — бір құрылғыда екеуі де ашық болуы мүмкін.
const TOKEN_KEYS = { admin: 'astral.token', kassa: 'astral.kassa.token' };
let tokenKey = TOKEN_KEYS.admin;
let onUnauthorized = () => {};

function save(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* сақтау орны жабық (жеке режим) */
  }
}

export const auth = {
  /** Қай қосымшаның токені: 'admin' (әдепкі) немесе 'kassa'. */
  use(scope) {
    tokenKey = TOKEN_KEYS[scope] ?? TOKEN_KEYS.admin;
  },
  get token() {
    try {
      return localStorage.getItem(tokenKey);
    } catch {
      return null;
    }
  },
  set token(value) {
    save(tokenKey, value);
  },
  /** Басқа қосымшаның токенін сақтау (мысалы, әкімші бетінде касса сілтемесі ашылса). */
  saveFor(scope, value) {
    save(TOKEN_KEYS[scope], value);
  },
  /** Токен жарамсыз болғанда (401) шақырылатын функция — кіру бетін көрсетеді. */
  onUnauthorized(fn) {
    onUnauthorized = fn;
  },
};

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/**
 * @param {string} path  '/admin/types' сияқты (алдына /api қосылады)
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network');
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && (path.startsWith('/admin') || path.startsWith('/kassa'))) {
      auth.token = null;
      onUnauthorized();
    }
    throw new ApiError(res.status, data.error || `http_${res.status}`, data);
  }
  return data;
}
