/* nomodule-warning.js — Shown to browsers that don't support ES modules at
 * all (IE11, Edge Legacy, Safari ≤10). Pure ES5 syntax; no modern features.
 * Modern browsers skip this script entirely thanks to the `nomodule` attribute. */
(function () {
  if (!document.body) return;
  document.body.innerHTML =
    '<div style="max-width:640px;margin:4rem auto;padding:1.5rem;border:1px solid #c0392b;' +
    'border-radius:10px;background:#fff;font-family:sans-serif;color:#1a1a2e;line-height:1.6">' +
    '<h1 style="font-family:Georgia,serif;font-size:1.6rem;margin-bottom:.75rem">' +
    'Browser too old for this site</h1>' +
    '<p>This site needs a browser that supports ES modules. Please upgrade to a recent ' +
    'Chrome, Edge, Firefox, or Safari.</p>' +
    '<p style="margin-top:1rem">You can browse the raw API at ' +
    '<a href="https://api.audioblast.org/" ' +
    'style="color:#40916c">api.audioblast.org</a>.</p></div>';
})();
