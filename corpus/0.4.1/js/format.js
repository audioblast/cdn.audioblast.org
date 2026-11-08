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

/**
 * Whether a level of a taxon's hierarchy (its Order, say) is the taxon itself: the
 * level names the taxon, at the taxon's rank where it has one. A taxon can share its
 * name with one of another rank, so the name alone is enough only where there is no rank.
 *   isOwnLevel('Crassiclitellata', 'Order', 'Order', 'Crassiclitellata') → true
 *   isOwnLevel('Aus', 'Genus', 'Class', 'Aus')                           → false
 *   isOwnLevel('Aus', '', 'Class', 'Aus')                                → true
 */
export function isOwnLevel(taxon, taxonRank, level, name) {
  if (!name || name !== taxon) return false;
  const rank = String(taxonRank ?? '').toLowerCase();
  return !rank || rank === String(level).toLowerCase();
}

// ── Specimens ─────────────────────────────────────────────────────

/** How many specimens a taxon's list of them, or a recording's, shows. */
export const SPECIMEN_LIST_CAP = 100;

/**
 * A taxon's name as HTML: italic at a rank whose names are (ITALIC_RANKS), with its
 * subgenus in brackets. Pass no rank for a name of no known rank.
 */
export function nameHtml(name, rank) {
  const n = esc(subgenusBrackets(name));
  return ITALIC_RANKS.has(String(rank || '').toLowerCase()) ? `<i>${n}</i>` : n;
}

/**
 * A specimen's details as the rows of its page's metadata table: [label, html] for each
 * detail it has, with the values escaped. `taxonHtml` is the taxon it is identified as,
 * as HTML (a link, or its name), or '' for none.
 */
export function specimenDetails(s, taxonHtml = '') {
  const place = s.decimalLatitude && s.decimalLongitude ? `${s.decimalLatitude}, ${s.decimalLongitude}` : '';
  const rows = [
    ['Identified as',            taxonHtml],
    ['Institution',              esc(s.institutionCode)],
    ['Collection',               esc(s.collectionCode)],
    ['Catalogue number',         esc(s.catalogNumber)],
    ['Other catalogue numbers',  esc(s.otherCatalogNumbers)],
    ['Type status',              esc(s.typeStatus)],
    ['Basis of record',          esc(s.basisOfRecord)],
    ['Sex',                      esc(s.sex)],
    ['Life stage',               esc(s.lifeStage)],
    ['Individuals',              esc(s.individualCount)],
    ['Collected by',             esc(s.recordedBy)],
    ['Date collected',           esc(s.eventDate)],
    ['Identified by',            esc(s.identifiedBy)],
    ['Date identified',          esc(s.dateIdentified)],
    ['Identification qualifier', esc(s.identificationQualifier)],
    ['Locality',                 esc(s.locality)],
    ['Country',                  esc(s.countryCode)],
    ['Coordinates',              esc(place)],
    ['Remarks',                  esc(s.occurrenceRemarks)],
    ['Associated sequences',     esc(s.associatedSequences)],
  ];
  return rows.filter(([, v]) => v !== '');
}
