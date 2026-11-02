// Claude сілтемесінде сыртқы файлдар жүктелмейді — логотиптер бетке data: URI ретінде салынады
// (scripts/build-artifact.js: .webp → dataurl).
import mark from '../public/brand/mark.webp';
import full from '../public/brand/logo.webp';

export const LOGO_URL = mark;
export const LOGO_FULL_URL = full;
