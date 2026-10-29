/* compat-check.js — Tiny ES5-syntax feature probe.
 *
 * Runs before js/app.js (which uses ES2020 syntax). If the browser is too old
 * for the app, swap the page for a clear "please upgrade" message instead of
 * letting users stare at a broken layout.
 *
 * Must remain free of: optional chaining (?.), nullish coalescing (??),
 * template literals (back-tick strings), let/const, arrow functions,
 * for-of, classes, async/await — anything that would itself trigger a parse
 * error in the browsers we want to warn.
 *
 * Minimum versions targeted (= the app's actual floor):
 *   Chrome  80  (Feb 2020)
 *   Safari  13.1 (Mar 2020)
 *   Firefox 74  (Mar 2020)
 *   Edge    80  (Feb 2020)
 *
 * Anything older lacks optional chaining and will fail when app.js parses.
 */
(function () {
  var ok = true;

  // Runtime feature probes. We can't directly parse-test optional chaining
  // (`?.`) without `new Function`, which CSP blocks — but every browser that
  // has the features below also has `?.` and `??` (same release window:
  // Chrome 80, Safari 13.1, Firefox 74, all early 2020).
  if (typeof Promise === 'undefined' || !Promise.allSettled) ok = false;
  if (typeof URLSearchParams === 'undefined') ok = false;
  if (typeof fetch === 'undefined') ok = false;
  if (typeof Map === 'undefined' || typeof Set === 'undefined') ok = false;
  if (!('CSS' in window) || typeof window.CSS.escape !== 'function') ok = false;
  // String.prototype.matchAll shipped Chrome 73 / Safari 13 / FF 67 — the
  // tightest indicator that we're past the ES2020 syntax cutover.
  if (typeof String.prototype.matchAll !== 'function') ok = false;

  if (ok) return;

  // Replace the document body with an upgrade message. Inline styles only,
  // no class dependencies, no JS features past ES5.
  var msg =
    '<div style="max-width:640px;margin:4rem auto;padding:1.5rem 1.75rem;' +
    'border:1px solid #c0392b;border-radius:10px;background:#fff;' +
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
    'color:#1a1a2e;line-height:1.6">' +
      '<h1 style="font-family:Georgia,serif;font-size:1.6rem;margin:0 0 0.75rem">' +
        'Browser too old for this site' +
      '</h1>' +
      '<p style="margin:0 0 1rem">This site needs a browser released after early 2020 ' +
        '(Chrome 80, Safari 13.1, Firefox 74, or Edge 80 or newer).</p>' +
      '<p style="margin:0">You can browse the raw API at ' +
        '<a href="https://api.audioblast.org/" ' +
           'style="color:#40916c">api.audioblast.org</a> instead.</p>' +
    '</div>';

  // The body may not be parsed yet — defer to DOMContentLoaded if so.
  function replace() { document.body.innerHTML = msg; }
  if (document.body) replace();
  else document.addEventListener('DOMContentLoaded', replace);

  // Stop the module loader from running and tripping a parse error.
  // We can't unload a not-yet-loaded module from script, but we can flag it.
  window.__corpusBrowserTooOld = true;
})();
