// Runs before the app's modules. External, so the CSP needs no inline script.
(function () {
  // Zod probes for `new Function` while defining schemas. The CSP forbids it,
  // so the probe fails anyway but still raises a policy violation. Zod reads
  // this setting from here, so it applies before any schema module loads.
  window.__zod_globalConfig = { jitless: true };

  // Apply the last theme this browser used, so there is no flash of the wrong
  // palette. The app then applies the account's setting.
  var palettes = ['light', 'slate', 'warm', 'oled'];
  var saved = null;
  try {
    saved = window.localStorage.getItem('wikistow.theme');
  } catch {
    // Storage can be unavailable (private mode); fall back to the system.
  }
  var theme = palettes.indexOf(saved) >= 0 ? saved : null;
  // A plugin theme chosen in the desktop app, and shown last time (its plugin
  // on), is drawn over Light or Midnight slate.
  try {
    var chosen = JSON.parse(window.localStorage.getItem('wikistow.pluginTheme') || 'null');
    if (chosen && chosen.shown && chosen.base === 'dark') theme = 'slate';
    if (chosen && chosen.shown && chosen.base === 'light') theme = 'light';
  } catch {
    // Nothing kept, or not readable: the palette as above.
  }
  if (!theme) {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = dark ? 'slate' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
