/** Theme constants shared by the server root layout and the client ThemeProvider. */
export const THEME_STORAGE_KEY = "rf-theme";

/**
 * Runs in <head> before first paint so the stored or OS theme is applied
 * without a flash. Keep in sync with ThemeProvider's resolution logic.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.setAttribute("data-theme",d?"dark":"light");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
