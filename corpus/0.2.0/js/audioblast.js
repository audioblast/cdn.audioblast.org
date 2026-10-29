/**
 * audioblast.js — Generic client for the audioBlast API
 *
 * Framework-agnostic ES module. Not tied to any source or project.
 * API documentation: https://github.com/audioblast/api.audioblast.org
 *
 * Response shape for all paginated data endpoints:
 *   { data: object[], last_page: number, params: object, notes: object }
 *
 * Pagination is page-based (not offset). Default page size is 250 and can be
 * overridden via `page_size`.
 */

export const BASE_URL = 'https://api.audioblast.org';

// ── Core ───────────────────────────────────────────────────────────

let _callCount = 0;

async function get(path) {
  _callCount++;
  window.dispatchEvent(new CustomEvent('audioblast:call', { detail: { count: _callCount } }));
  const res = await fetch(BASE_URL + path);
  if (!res.ok) throw new Error(`AudioBlast API ${res.status}: ${path.split('?')[0]}`);
  return res.json();
}

function qs(params) {
  const pairs = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') {
      pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
  }
  return pairs.length ? '?' + pairs.join('&') : '';
}

// ── /data/recordings/ ─────────────────────────────────────────────

/**
 * Query recording metadata.
 *
 * Parameters and match behaviour (verified against the live API):
 *   source         string   contains    e.g. "bio.acousti.ca"
 *   id             string   exact
 *   name           string   fulltext    maps to Title column
 *   taxon          string   fulltext    maps to taxon column
 *   author         string   fulltext
 *   filename       string   contains    maps to file/filename column
 *   recording_type string   exact       maps to NonSpecimen column
 *   mime           string   exact       maps to type column
 *   duration_min   number   IGNORED     server emits no clause for these
 *   duration_max   number   IGNORED
 *   page           number               1-indexed (default 1)
 *   page_size      number               records per page (default 250)
 *   output         string               'JSON' | 'nakedJSON' | 'tabulator'
 *
 * "fulltext" is MATCH(col) AGAINST ('term*' IN BOOLEAN MODE): it matches on
 * whole-word prefixes, so "Gryll" finds "Gryllus" but a mid-word fragment
 * like "yllus" finds nothing, and stopwords/short terms may drop out.
 *
 * Response data fields: id, source, name (Title), taxon, filename, author,
 *   recording_type (NonSpecimen), mime (type), date, time, time_of_day,
 *   duration, post_date, human_size, bytes, deployment, lat, lon, license,
 *   info_url, device.  (human_size and bytes were formerly size/size_raw.)
 *
 * `filename` is a full, URL-encoded absolute URL, not a bare name.
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function recordings({
  source, id, name, taxon, filename, author, recording_type, mime,
  duration_min, duration_max,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/recordings/' + qs({
    source, id, name, taxon, filename, author, recording_type, mime,
    duration_min, duration_max,
    page, page_size, output,
  }));
}

// ── /data/recordingstaxa/ ─────────────────────────────────────────

/**
 * @deprecated The recordingstaxa module is being retired server-side.
 * Build the same rows from /data/recordings/ + /data/taxa/ instead: fetch the
 * taxonomy once and join on the `taxon` name, which is identical in both.
 * See recordingRowsWithTaxonomy() in api.js.
 *
 * Query recordings joined with the full taxonomic hierarchy.
 * Use this to filter by higher ranks (family, order, etc.) or to browse
 * taxa that have recordings.
 *
 * Key difference from /data/recordings/:
 *   source and taxon are EXACT match here, and taxon is not fulltext-matched
 *   as it is on /data/recordings/ — a partial name returns nothing.
 *
 * Parameters:
 *   source, id, taxon, rank, species, genus, tribe, subfamily, family,
 *   suborder, order, class (as cls), kingdom, mime, recording_type  — exact
 *   name, author                                                   — contains
 *   page, page_size (default 250), output ('JSON' | 'nakedJSON')
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function recordingsTaxa({
  source, id, name, taxon, author, recording_type, mime,
  rank, species, genus, tribe, subfamily, family, suborder,
  order, class: cls, kingdom,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/recordingstaxa/' + qs({
    source, id, name, taxon, author, recording_type, mime,
    rank, species, genus, tribe, subfamily, family, suborder,
    order, class: cls, kingdom,
    page, page_size, output,
  }));
}

// ── /data/taxa/ ───────────────────────────────────────────────────

/**
 * Query the taxonomic hierarchy itself — one row per taxon, no recordings.
 *
 * This is the replacement for the taxonomy half of /data/recordingstaxa/.
 * `taxon` here is identical to `taxon` on /data/recordings/, so the two join
 * on that field with no normalisation.
 *
 * Every filter is EXACT match — the same semantics recordingstaxa had, and
 * unlike /data/recordings/ where taxon is fulltext and cannot match exactly.
 *
 * Parameters (all exact):
 *   source, id (taxon ID within its source — NOT a recording ID), taxon,
 *   rank, species, genus, tribe, subfamily, family, suborder, order,
 *   class (as cls), kingdom
 *   page, page_size (default 250), output
 *
 * Response data fields: source, id, taxon, rank, species, genus, tribe,
 *   subfamily, family, suborder, order, class, kingdom
 *
 * The whole table for one source is small enough to pull in a single request
 * with a large page_size, which is how api.js builds its taxonomy index.
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function taxa({
  source, id, taxon, rank, species, genus, tribe, subfamily,
  family, suborder, order, class: cls, kingdom,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/taxa/' + qs({
    source, id, taxon, rank, species, genus, tribe, subfamily,
    family, suborder, order, class: cls, kingdom,
    page, page_size, output,
  }));
}

// ── /data/traitstaxa/ ─────────────────────────────────────────────

/**
 * Query traits joined with the full taxonomic hierarchy.
 * Use this to filter traits by higher ranks (family, genus, etc.)
 * or to get trait counts across the taxonomy.
 *
 * Parameters (all exact match):
 *   source, traitID, taxonID, taxon, trait, url, value,
 *   callType, sex, min, max,
 *   rank, species, genus, tribe, subfamily, family,
 *   suborder, order, class (as cls), kingdom
 *   page, page_size (default 250), output
 *
 * The response's `params` echo omits callType and sex, but the server does
 * honour both — they appear in the generated WHERE clause.
 *
 * Response data fields: source, traitID, taxonID, taxon, trait, url,
 *   value, callType, sex, min, max, rank, species, genus, family,
 *   suborder, order, class, kingdom, …
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function traitsTaxa({
  source, traitID, taxonID, taxon, trait, url, value,
  callType, sex, min, max,
  rank, species, genus, tribe, subfamily, family,
  suborder, order, class: cls, kingdom,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/traitstaxa/' + qs({
    source, traitID, taxonID, taxon, trait, url, value,
    callType, sex, min, max,
    rank, species, genus, tribe, subfamily, family,
    suborder, order, class: cls, kingdom,
    page, page_size, output,
  }));
}

// ── /data/traits/ ─────────────────────────────────────────────────

/**
 * Query acoustic and biological trait data.
 *
 * Parameters — every filter here is EXACT match (source is the only
 * contains match). A partial value returns nothing, so free-text input
 * should be fed from autocomplete rather than typed:
 *   source (contains), id, taxon, trait, trait_ontology, value,
 *   call_type, call_type_ontology, call_part, call_qualifier, sex,
 *   temperature, value_min, value_max
 *   page, page_size (default 250), output
 *
 * Response data fields: source, id, taxon, trait, trait_ontology, value,
 *   call_type, call_type_ontology, call_part, call_qualifier, sex,
 *   temperature, value_min, value_max
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function traits({
  source, id, taxon, trait, trait_ontology,
  value, call_type, sex, temperature, value_min, value_max,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/traits/' + qs({
    source, id, taxon, trait, trait_ontology,
    value, call_type, sex, temperature, value_min, value_max,
    page, page_size, output,
  }));
}

// ── /data/annomate/ ───────────────────────────────────────────────

/**
 * Query annotations on recordings (from the ann-o-mate annotation system).
 *
 * Parameters and match behaviour:
 *   source               string   contains    source of the annotation
 *   source_id            string   exact       recording ID within recording_source
 *   recording_source     string   exact       source of the annotated recording,
 *                                             which need not be the annotation's
 *                                             (a corpus can mark regions of
 *                                             another source's recordings)
 *   annotator            string   contains
 *   annotation_id        string   exact
 *   annotation_date      string   contains
 *   annotation_info_url  string   contains    URL linking to annotation details
 *   recording_url        string   contains    URL of the annotated recording
 *   time_start           string   exact       start time (seconds) within recording
 *   time_end             string   exact       end time (seconds) within recording
 *   taxon                string   contains    species/taxon identified
 *   type                 string   contains    annotation classification type
 *   lat                  string   contains    latitude
 *   lon                  string   contains    longitude
 *   contact              string   contains    contact person
 *   format               string               'internal' | 'ac' (Audubon Core)
 *   page                 number               1-indexed (default 1)
 *   page_size            number               records per page (default 250)
 *   output               string               'JSON' | 'nakedJSON' | 'tabulator'
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function annotations({
  source, source_id, recording_source, annotator, annotation_id, annotation_date,
  annotation_info_url, recording_url,
  time_start, time_end, taxon, type, lat, lon, contact,
  format, page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/annomate/' + qs({
    source, source_id, recording_source, annotator, annotation_id, annotation_date,
    annotation_info_url, recording_url,
    time_start, time_end, taxon, type, lat, lon, contact,
    format, page, page_size, output,
  }));
}

// ── /data/specimens/ ──────────────────────────────────────────────

/**
 * Query the specimens and observations that recordings are of. Their columns
 * are Darwin Core terms. decimalLatitude and decimalLongitude are where the
 * specimen was collected or observed, not where a recording of it was made.
 *
 * Parameters:
 *   source            string   exact
 *   id                string   exact; several may be comma-joined
 *   scientificName    string   contains
 *   decimalLatitude   range    "min:max", both ends included
 *   decimalLongitude  range    "min:max", both ends included
 *   page, page_size (default 250), output
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function specimens({
  source, id, scientificName, decimalLatitude, decimalLongitude,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/specimens/' + qs({
    source, id, scientificName, decimalLatitude, decimalLongitude,
    page, page_size, output,
  }));
}

// ── /data/links/ ──────────────────────────────────────────────────

/**
 * Query the links between records: what a recording is of, where it was made,
 * and so on. subject_type and object_type name the module at each end
 * ('recordings', 'specimens', 'taxa', 'locations', ...), and predicate is the
 * IRI of the relationship, e.g.
 * http://rs.tdwg.org/ac/terms/associatedSpecimenReference.
 *
 * Parameters (all exact):
 *   source, subject_type, subject_source, subject_id, predicate,
 *   object_type, object_source, object_id, qualifier
 *   page, page_size (default 250), output
 *
 * @returns {Promise<{data: object[], last_page: number, notes: object}>}
 */
export function links({
  source, subject_type, subject_source, subject_id, predicate,
  object_type, object_source, object_id, qualifier,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/data/links/' + qs({
    source, subject_type, subject_source, subject_id, predicate,
    object_type, object_source, object_id, qualifier,
    page, page_size, output,
  }));
}

// ── /analysis/birdnet_selection/ ─────────────────────────────────

/**
 * Query BirdNET identification results for recordings.
 *
 * Parameters:
 *   source          string   filter by source
 *   id              string   filter by recording id within source
 *   analysis_id     string   filter by annotation id within source
 *   annotation_date string   filter by annotation date
 *   time_start      integer  start time in seconds
 *   time_end        integer  end time in seconds
 *   taxon           string   taxon to filter by
 *   confidence      integer  BirdNET confidence score
 *   deployment      string   deployment identifier
 *   page, page_size, output
 *
 * @returns {Promise<{data: object[], last_page: number}>}
 */
export function birdnetSelections({
  source, id, analysis_id, annotation_date, time_start, time_end,
  taxon, confidence, deployment,
  page = 1, page_size = 250, output = 'JSON',
} = {}) {
  return get('/analysis/birdnet_selection/' + qs({
    source, id, analysis_id, annotation_date, time_start, time_end,
    taxon, confidence, deployment,
    page, page_size, output,
  }));
}

// ── /standalone/data/ ─────────────────────────────────────────────

/**
 * Count items across all data tables.
 * Response: { data: { counts: { recordings: N, taxa: N, … }, total: N } }
 *
 * @param {string} [source]  optional exact source filter
 * @param {string} [id]      optional recording ID filter
 */
export function dataCounts({ source, id } = {}) {
  return get('/standalone/data/fetch_data_counts/' + qs({ source, id }));
}

// ── /data/{module}/autocomplete/ ──────────────────────────────────

/**
 * Autocomplete values for a filterable field on a data module.
 *
 * Only an allowlist of fields is autocompletable. A rejected field returns
 * 200 with no `data` key at all and `notes` reading "Autocomplete not allowed
 * on field" — so callers must treat a missing `data` as an empty list rather
 * than assume an array. Known-denied: traits' value, call_type, sex,
 * trait_ontology and temperature, and traitstaxa's value. traitstaxa does
 * allow callType and sex, which cover two of those.
 *
 * Unlike the data endpoints, matching here is substring (LIKE '%…%').
 *
 * @param {'recordings'|'recordingstaxa'|'traits'|'traitstaxa'|'taxa'|'annomate'} module
 * @param {string} param        field to autocomplete, e.g. 'taxon', 'family', 'source'
 * @param {object} [opts]
 * @param {string} [opts.startsWith]   prefix match  (?s=)
 * @param {string} [opts.contains]     substring match (?c=)
 * @param {string} [opts.source]       restrict suggestions to one collection
 */
export function autocomplete(module, param, { startsWith, contains, source } = {}) {
  return get(
    `/data/${encodeURIComponent(module)}/autocomplete/${encodeURIComponent(param)}/` +
    qs({ s: startsWith, c: contains, source }),
  );
}

// ── Source-bound client ────────────────────────────────────────────

/**
 * Create a client pre-bound to a specific source.
 * Every data call automatically includes the source filter — callers
 * cannot omit or override it.
 *
 * @param {string} source  e.g. 'bio.acousti.ca'
 * @returns {{
 *   source: string,
 *   recordings(params?): Promise,
 *   recordingsTaxa(params?): Promise,  // deprecated
 *   taxa(params?): Promise,
 *   traitsTaxa(params?): Promise,
 *   traits(params?): Promise,
 *   annotations(params?): Promise,
 *   specimens(params?): Promise,
 *   links(params?): Promise,
 *   dataCounts(params?): Promise,
 *   autocomplete(module, param, opts?): Promise,
 * }}
 *
 * @example
 *   import { forSource } from './audioblast.js';
 *   const ab = forSource('bio.acousti.ca');
 *   const res = await ab.recordings({ taxon: 'Gryllus' });
 */
export function forSource(source) {
  // Pass-through wrapper: forward all caller params but pin `source`.
  // Callers cannot omit or override source — it's always this client's source.
  const bind = fn => (params = {}) => fn({ ...params, source });

  return {
    source,
    recordings:        bind(recordings),
    recordingsTaxa:    bind(recordingsTaxa),   // deprecated — see above
    taxa:              bind(taxa),
    traitsTaxa:        bind(traitsTaxa),
    traits:            bind(traits),
    annotations:       bind(annotations),
    birdnetSelections: bind(birdnetSelections),
    specimens:         bind(specimens),
    links:             bind(links),
    dataCounts:        bind(dataCounts),
    autocomplete:      (module, param, opts = {}) => autocomplete(module, param, { ...opts, source }),
  };
}

