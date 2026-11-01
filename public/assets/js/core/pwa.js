// PWA: service worker тіркеу және «Қосымшаны орнату» түймесі.
let deferredPrompt = null;
const listeners = new Set();

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Әзірлеу кезінде localhost-та да жұмыс істейді; HTTPS міндетті (localhost-тан басқа).
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  for (const fn of listeners) fn();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  for (const fn of listeners) fn();
});

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

/** Браузер орнатуды ұсына ала ма (Android/Chrome/Edge). */
export const canPromptInstall = () => deferredPrompt !== null;

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  for (const fn of listeners) fn();
  return outcome === 'accepted';
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
