/** Shared by the pre-paint script (server layout) and the client theme store. */
export const THEME_STORAGE_KEY = 'ira.theme';

/**
 * Runs synchronously in <head> before first paint. Light is the default for
 * everyone (the OS preference is ignored); dark only when the user chose it.
 * Dependency-free ES5.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})()`;
