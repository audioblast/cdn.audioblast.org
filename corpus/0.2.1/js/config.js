/**
 * config.js — Defaults for every site built on the corpus core.
 *
 * A site's own config (its config/site.js) has the same shape. start() in app.js
 * merges it over these defaults before the page is set up, and the tools in tools/
 * merge it the same way. Only `source` has no default: a site must set it.
 */

const config = {

  // ── Corpus ────────────────────────────────────────────────────────

  /**
   * The corpus version the site runs on, as '0.2.0'. tools/build-page.mjs pins the
   * site's page to it, and stops if it is run from a different version; the site's
   * Pages workflow reads it from here too, so the version is set in one place. Null
   * pins the page to whichever corpus version builds it.
   */
  corpusVersion: null,

  // ── API ───────────────────────────────────────────────────────────

  /**
   * audioBlast source identifier. All API queries are scoped to it. Required.
   */
  source: null,

  // ── Branding ──────────────────────────────────────────────────────

  siteName:        'Recordings',
  siteTagline:     '',
  siteDescription: 'Sound recordings.',

  /**
   * The logo in the header: the site's name in two parts, the second in the accent
   * colour, as ['Bio', 'Acoustica']. Null shows siteName in one part.
   */
  logo: null,

  // ── Copy ──────────────────────────────────────────────────────────
  // The words tools/build-page.mjs writes into the site's page. A site can set any
  // of a group's fields, and the others come from here.

  /** The home page's hero: a first line, a second line in italics, and a paragraph. */
  hero: {
    lead:     'Listen to the',
    emphasis: 'recordings',
    text:     'Sound recordings from the audioBLAST platform.',
  },

  /**
   * The examples in the empty filter boxes on the traits and annotations pages,
   * after "e.g.". Pick values the collection has.
   */
  examples: {
    taxon:    'Gryllus',
    trait:    'carrier frequency',
    value:    '5000',
    callType: 'calling song',
    sex:      'male',
  },

  /** The About page's content: an HTML fragment, which the app loads into the page. */
  aboutUrl: 'config/about.html',

  // ── Features ──────────────────────────────────────────────────────

  /**
   * The parts of the core a site can leave out, each named as its page is in the
   * address (?page=map):
   *   browse       Browse taxa: the taxonomic tree, and the home page's button for it
   *   traits       Browse traits, the traits count in the header, the Traits tab of a
   *                taxon's view, and the traits column of the tree
   *   annotations  Browse annotations, the annotations count in the header, and the
   *                Annotations tab of a taxon's view. A recording's own annotations
   *                stay on its page.
   *   map          the Recordings map
   * All are on. A site leaves one out by setting it to false, as { map: false }:
   * tools/build-page.mjs leaves it out of the site's page, and the app neither shows
   * it nor asks the API for it. A taxon's view and its page (tools/build-static.mjs)
   * are not part of Browse taxa, and stay: a recording links to its taxon's.
   */
  features: {
    browse:      true,
    traits:      true,
    annotations: true,
    map:         true,
  },

  /**
   * Whether the site has this feature. start() puts a site's features in place of
   * these, so a feature the site doesn't name is on.
   */
  hasFeature(name) {
    return config.features?.[name] !== false;
  },

  // ── Audio files ───────────────────────────────────────────────────

  /**
   * Convert a raw filename from the API into a playable/downloadable URL.
   * /data/recordings/ returns absolute, URL-encoded addresses that the audio host
   * serves cross-origin, so the value is used as-is. Return '' or null if no audio
   * is available for a recording.
   *
   * Callers pass the result through safeUrl() before it reaches the DOM,
   * so a non-http(s) value here is rejected rather than rendered.
   *
   * @param  {string} filename  value of the `filename` field from the API
   * @returns {string}
   */
  resolveFileUrl(filename) {
    return filename || '';
  },

  // ── External links ────────────────────────────────────────────────

  /**
   * URL of a recording on an original site, shown on the detail page.
   * Return null to suppress the link.
   *
   * @param  {string|number} id  recording ID
   * @returns {string|null}
   */
  recordingPageUrl(id) {
    return null;
  },

  /**
   * URL of a taxon's page on another site, shown on the taxon page.
   * Return null to suppress the link.
   *
   * @param  {string} name  scientific name of the taxon
   * @returns {string|null}
   */
  browseTaxonUrl(name) {
    return null;
  },

  /**
   * GitHub repository (owner/repo) used for data quality issue reports.
   * Set to null to suppress the "Report data quality issue" link.
   */
  githubRepo: null,

  // ── Recording types ───────────────────────────────────────────────

  /**
   * Recording types to exclude from all listing results.
   * Values are matched case-insensitively against the recording_type field.
   */
  excludeRecordingTypes: [],

  /**
   * If not empty, only recordings of these types are shown, and recordings of
   * any other type, or of none, are left out.
   * Values are matched case-insensitively against the recording_type field.
   */
  includeRecordingTypes: [],

  /**
   * Whether recordings of this type are shown: one of includeRecordingTypes,
   * if there are any, and not one of excludeRecordingTypes. The app and the
   * static-page build both decide with this.
   */
  recordingTypeAllowed(type) {
    const t = String(type ?? '').toLowerCase();
    const has = list => (list ?? []).some(x => x.toLowerCase() === t);
    if (config.includeRecordingTypes?.length && !has(config.includeRecordingTypes)) return false;
    return !has(config.excludeRecordingTypes);
  },

  /**
   * Recording types for which BirdNET identification results are fetched and
   * displayed as a second annotation set in the detail view. Empty for none.
   * Values are matched case-insensitively against the recording_type field.
   */
  soundscapeTypes: [],

  // ── Map ───────────────────────────────────────────────────────────

  /**
   * Basemap for the recordings map (js/map.js): the tile URL template and the
   * attribution its tiles need. tools/build-page.mjs allows the URL's host on
   * img-src in the page's Content-Security-Policy. The OpenStreetMap tile
   * server is for light use only, so a busy site should point this at a tile
   * provider or a basemap of its own.
   */
  mapTiles: {
    url:         'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },

};

export default config;
