/**
 * format.js — Helpers that the app and the tools share
 *
 * tools/build-static.mjs and tools/build-page.mjs import this module in Node,
 * so it imports nothing and touches no browser globals. The app loads it too,
 * so it keeps to what the app's browsers support (Chrome 80, Safari 13.1,
 * Firefox 74).
 */

const _ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a string for safe HTML insertion, in text or in a quoted attribute */
export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => _ESCAPES[c]);
}

// Return url unchanged if it uses a safe protocol; empty string otherwise.
// Blocks javascript:, data:, vbscript:, etc. from API-supplied URLs.
export function safeUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (/^(https?:|mailto:|\/|#|\?)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // unrecognised scheme — reject
  return s; // relative path
}

// Return url, trimmed, if it is an absolute http(s) address; empty string
// otherwise, for a relative address too. The static pages link only these.
export function httpUrl(url) {
  const s = String(url ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// Ranks whose names are italicised under the ICZN / ICN codes.
export const ITALIC_RANKS = new Set([
  'genus', 'subgenus', 'species', 'subspecies', 'variety', 'form', 'infraspecies',
]);

/**
 * Insert brackets around a subgenus in a taxonomic name.
 * Under ICZN, subgenus names begin with an uppercase letter while species
 * and subspecies epithets begin with lowercase — so capitalisation alone
 * identifies the subgenus without needing the rank.
 *   "Aus Bus"         → "Aus (Bus)"
 *   "Aus Bus cus"     → "Aus (Bus) cus"
 *   "Aus bus cus"     → "Aus bus cus"  (no subgenus, 'bus' is lowercase)
 */
export function subgenusBrackets(name) {
  const parts = name.split(' ');
  if (parts.length < 2 || !/^[A-Z]/.test(parts[1])) return name;
  return `${parts[0]} (${parts[1]})${parts.length > 2 ? ' ' + parts.slice(2).join(' ') : ''}`;
}
