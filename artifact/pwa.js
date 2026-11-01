// Claude сілтемесінің ішінде service worker және «Қосымшаны орнату» жоқ.
export const registerServiceWorker = () => {};
export const isStandalone = () => false;
export const isIos = () => false;
export const canPromptInstall = () => false;
export const promptInstall = async () => false;
export const onInstallChange = () => () => {};
