/**
 * Клиентке қате коды (мысалы 'invalid_name') қайтарылады —
 * мәтінді клиент өз тілінде (KZ/RU) көрсетеді.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, details) => new HttpError(400, code, details);
export const notFound = (code = 'not_found') => new HttpError(404, code);
