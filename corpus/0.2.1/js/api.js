/**
 * api.js — audioBlast API interface, scoped to the configured collection.
 *
 * All requests are automatically scoped to config.source via forSource().
 */

import { forSource } from './audioblast.js';
import config from './config.js';

// Built on first use, so that the site's config has been merged in by then (start() in app.js).
let _ab = null;
function ab() {
  if (!_ab) _ab = forSource(config.source);
  return _ab;
}

// ── In-memory LRU cache ───────────────────────────────────────────
// Repeat detail views (back/forward, click → back → click) used to re-fetch
// the same recording. A small per-endpoint LRU avoids it. Keep the budget
// tight — detail rows are <1 KB each, and the cache is only for repeat
// navigation within a session.
const CACHE_SIZE = 32;
function _makeLru(max = CACHE_SIZE) {
  // Map preserves insertion order, so the oldest key is always first.
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k); m.set(k, v); // move-to-front
      return v;
    },
    set(k, v) {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value);
    },
  };
}
const _recordingCache   = _makeLru();
const _recordingTaxa    = _makeLru();
const _annotationsCache = _makeLru();
const _birdnetCache     = _makeLru();
const _taxonomyCache    = _makeLru();

// ── Taxonomy index (replaces /data/recordingstaxa/) ───────────────
// recordingstaxa is being retired, and /data/recordings/ carries no hierarchy
// and cannot filter by rank. So we rebuild those rows client-side: pull the
// taxonomy from /data/taxa/ and join it onto recordings by `taxon`, which is
// the identical string in both modules.
//
// Both tables are small enough for one request each at this page size, so the
// "paged" fetch below almost always resolves in a single round trip.
const BULK_PAGE_SIZE = 10000;
const PAGE_SIZE      = 250;

const TAXONOMY_FIELDS = [
  'rank', 'species', 'genus', 'tribe', 'subfamily',
  'family', 'suborder', 'order', 'class', 'kingdom',
];

// Fetch every page of an endpoint. Starts with a large page_size so the common
// case is one call; only loops if the server still reports more pages.
async function _fetchAll(fn, params = {}) {
  const first = await fn({ ...params, page: 1, page_size: BULK_PAGE_SIZE });
  const rows  = [...(first.data ?? [])];
  const last  = first.last_page ?? 1;
  if (last > 1) {
    const pages = await Promise.all(
      Array.from({ length: last - 1 }, (_, i) =>
        fn({ ...params, page: i + 2, page_size: BULK_PAGE_SIZE })
          .then(r => r.data ?? [])
          .catch(() => [])),
    );
    for (const page of pages) rows.push(...page);
  }
  return rows;
}

/**
 * The source's whole taxonomy, keyed by taxon name for joining onto
 * recordings. Cached for the session; a failure clears the cache so the next
 * call retries.
 *
 * @returns {Promise<Map<string,object>>}
 */
let _taxonomyPromise = null;
function _taxonomy() {
  if (!_taxonomyPromise) {
    _taxonomyPromise = _fetchAll(ab().taxa)
      .then(rows => {
        const byTaxon = new Map();
        for (const row of rows) {
          if (row.taxon && !byTaxon.has(row.taxon)) byTaxon.set(row.taxon, row);
        }
        return byTaxon;
      })
      .catch(err => { _taxonomyPromise = null; throw err; });
  }
  return _taxonomyPromise;
}

/** The source's taxa by name, for linking a name to its taxon's page. */
export function taxonRowsByName() { return _taxonomy(); }

/** Attach the taxonomic hierarchy to recording rows, by `taxon` name. */
function _withTaxonomy(rows, byTaxon) {
  return rows.map(r => {
    const t = byTaxon.get(r.taxon);
    if (!t) return r;
    const out = { ...r };
    for (const f of TAXONOMY_FIELDS) if (t[f] != null) out[f] = t[f];
    return out;
  });
}

/**
 * Every recording in the collection, with taxonomy joined on — the row shape
 * /data/recordingstaxa/ used to return.
 *
 * This is the one heavy call (a few MB), so it is lazy: only rank-filtered
 * views and the browse tree need it. Plain listing, search and the detail page
 * stay server-paged and never trigger it.
 */
let _allRowsPromise = null;
export function recordingRowsWithTaxonomy() {
  if (!_allRowsPromise) {
    _allRowsPromise = Promise.all([_fetchAll(ab().recordings), _taxonomy()])
      .then(([rows, byTaxon]) => _withTaxonomy(rows, byTaxon))
      .catch(err => { _allRowsPromise = null; throw err; });
  }
  return _allRowsPromise;
}

/** Page an in-memory row array the way the API would. */
function _page(rows, page = 1, page_size = PAGE_SIZE) {
  const start = (Math.max(1, page) - 1) * page_size;
  return {
    data: rows.slice(start, start + page_size),
    last_page: Math.max(1, Math.ceil(rows.length / page_size)),
  };
}

/**
 * Autocomplete values for a field on a data module.
 * @param {'traits'|'traitstaxa'|'recordings'|'taxa'|'annomate'} module
 * @param {string} param   field name, e.g. 'taxon', 'trait'
 * @param {string} query   prefix to match
 */
export function fetchAutocomplete(module, param, query) {
  return ab().autocomplete(module, param, { contains: query });
}

/**
 * Fetch recordings with full taxonomy (rank, order, family, …)
 * joined on from the taxonomy index.
 *
 * `taxon` is matched by /data/recordings/ fulltext, so partial names work —
 * but a multi-word name is ORed word by word and will over-match. Use
 * fetchRecordingsForTaxon() when you need an exact taxon.
 * @param {object} [opts]
 * @param {string} [opts.taxon]      scientific name (contains match)
 * @param {number} [opts.page=1]     1-indexed
 * @param {number} [opts.page_size]  records per page (API default 250)
 * @returns {Promise<{data: object[], last_page: number}>}
 */
export async function fetchRecordings({ taxon, page = 1, page_size } = {}) {
  // Server-paged, so this stays light. Taxonomy is joined on from the cached
  // index; if that fetch fails the rows still render, just without rank tags.
  const [res, byTaxon] = await Promise.all([
    // One included type can be asked of the API, so pages are full of it rather
    // than mostly filtered away below; several are filtered below.
    ab().recordings({
      taxon: taxon || undefined,
      recording_type: config.includeRecordingTypes?.length === 1 ? config.includeRecordingTypes[0] : undefined,
      page, page_size,
    }),
    _taxonomy().catch(() => null),
  ]);
  const rows = byTaxon ? _withTaxonomy(res.data ?? [], byTaxon) : (res.data ?? []);
  return filterExcludedTypes({ ...res, data: rows });
}

/**
 * Fetch a single recording's full metadata by ID.
 * @param {string|number} id
 * @returns {Promise<object|null>}
 */
export async function fetchRecording(id) {
  const key = String(id);
  const hit = _recordingCache.get(key);
  if (hit !== undefined) return hit;
  const res = await ab().recordings({ id: key });
  const row = res.data?.[0] ?? null;
  _recordingCache.set(key, row);
  return row;
}

/**
 * Fetch a recording merged with its taxonomic hierarchy.
 * Returns the recording's fields plus kingdom, class, order, family, genus,
 * species and rank, resolved with one exact /data/taxa/ lookup.
 * @param {string|number} id
 * @returns {Promise<object|null>}
 */
export async function fetchRecordingTaxa(id) {
  const key = String(id);
  const hit = _recordingTaxa.get(key);
  if (hit !== undefined) return hit;

  const rec  = await fetchRecording(id);
  const name = rec?.taxon;
  let taxonRow = null;

  if (name) {
    const cached = _taxonomyCache.get(name);
    if (cached !== undefined) {
      taxonRow = cached;
    } else {
      // One exact lookup — cheaper than pulling the whole index for one panel.
      const res = await ab().taxa({ taxon: name }).catch(() => null);
      taxonRow = res?.data?.[0] ?? null;
      _taxonomyCache.set(name, taxonRow);
    }
  }

  // Callers expect the merged shape recordingstaxa returned. `taxa.id` is a
  // taxon ID, not a recording ID, so put the recording's own id back.
  const merged = taxonRow
    ? { ...(rec ?? {}), ...taxonRow, id: rec?.id ?? id, taxon_id: taxonRow.id }
    : rec ?? null;
  _recordingTaxa.set(key, merged);
  return merged;
}

/**
 * Fetch taxa that have recordings in the configured source.
 * Each row is a recording with its taxonomy attached, so counting rows per
 * taxon gives that taxon's recording count.
 * Deduplicate by taxon field if you need a unique taxon list.
 * @param {number} [page=1]
 * @returns {Promise<{data: object[], last_page: number}>}
 */
export async function fetchTaxa(page = 1) {
  // The browse tree counts one row per recording to get its per-taxon totals,
  // so this returns recording rows with taxonomy attached, not taxa rows.
  // Paged at BULK_PAGE_SIZE so page 1 carries everything and last_page is 1.
  //
  // Only rows whose taxon resolves can be placed in a taxonomic tree. A few
  // dozen carry multi-species strings ("Buteo buteo; Accipiter nisus; …")
  // that are not taxa in their own right; recordingstaxa's inner join dropped
  // them as well, so excluding them keeps the tree as it was. They stay
  // visible in listing and search, which do not need a taxonomy to place them.
  // See "Multi-taxa `taxon` strings" in TODO.md.
  const [rows, byTaxon] = await Promise.all([recordingRowsWithTaxonomy(), _taxonomy()]);
  const placed = excludeTypes(rows).filter(r => byTaxon.has(r.taxon));
  return _page(placed, page, BULK_PAGE_SIZE);
}

/**
 * dataCounts is the same endpoint for every kind of count, so we cache the
 * single in-flight promise and resolve all four count-fetchers from it.
 * Returns the counts object, or {} if the call fails.
 */
let _countsPromise = null;
function _sharedCounts() {
  if (!_countsPromise) {
    _countsPromise = ab().dataCounts()
      .then(res => {
        // The API gives the same empty answer for a source with no records as for one
        // it does not know, so an empty source is reported here, where a misspelt one shows.
        if (res?.data && Number(res.data.total) === 0) {
          console.warn(`audioBlast has no records for source "${config.source}": check the source in the site's config.`);
        }
        return res?.data?.counts ?? {};
      })
      .catch(() => {
        _countsPromise = null; // allow retry next call
        return {};
      });
  }
  return _countsPromise;
}

/**
 * Total recording count for the configured source.
 * Uses the dataCounts standalone endpoint; falls back to last_page × 50.
 * @returns {Promise<number>}
 */
export async function fetchRecordingCount() {
  const counts = await _sharedCounts();
  const n = Number(counts.recordings ?? 0);
  if (n > 0) return n;
  const res = await ab().recordings({ page: 1, page_size: PAGE_SIZE });
  return (res.last_page ?? 1) * PAGE_SIZE;
}

/**
 * Total taxon count for the configured source.
 * Uses the dataCounts standalone endpoint; falls back to last_page × 50.
 * @returns {Promise<number>}
 */
export async function fetchTaxaCount() {
  const counts = await _sharedCounts();
  const n = Number(counts.taxa ?? 0);
  if (n > 0) return n;
  const res = await ab().taxa({ page: 1, page_size: PAGE_SIZE });
  return (res.last_page ?? 1) * PAGE_SIZE;
}

/**
 * Total trait-measurement count for the configured source.
 * Tries dataCounts first (keys 'traits' or 'traitstaxa');
 * falls back to /data/traits/ last_page × 50.
 * @returns {Promise<number>}
 */
export async function fetchTraitsCount() {
  const counts = await _sharedCounts();
  const n = Number(counts.traits ?? counts.traitstaxa ?? 0);
  if (n > 0) return n;
  const res = await ab().traits({ page: 1 });
  return (res.last_page ?? 1) * 50;
}

// Keep the recording types config.recordingTypeAllowed() lets through: those in
// config.includeRecordingTypes if any, and none in config.excludeRecordingTypes.
// Row-level, so locally-held rows can be filtered *before* paging — otherwise
// excluded rows still count toward last_page and the displayed total.
function excludeTypes(rows) {
  return rows.filter(r => config.recordingTypeAllowed(r.recording_type));
}

// Same, for a server response whose page has already been chosen for us.
function filterExcludedTypes(res) {
  return { ...res, data: excludeTypes(res.data ?? []) };
}

// Rank fields probed in parallel; if more than one returns rows we pick the
// most-specific match (leftmost in this list).
const _RANK_FIELDS = ['taxon', 'genus', 'family', 'order', 'class', 'kingdom'];

/**
 * Probe each taxonomic rank field in parallel until one returns results for
 * `name`. Returns the params object to reuse for paged queries, e.g.
 * { class: 'Amphibia' }. Falls back to { taxon: name } if nothing matches. A taxon
 * whose own row gives a rank in _RANK_FIELDS (other than taxon) takes that rank
 * without probing.
 *
 * Parallel + `Promise.any`-style early-return: the *most-specific* rank that
 * matches wins, but the wait time is bounded by the slowest probe instead of
 * by the sum of probes.
 */
export async function detectTaxonParams(name) {
  // The taxon's own rank names its field, when it has one. Probing the recordings
  // cannot tell an order from a species it shares a name with: a recording whose
  // taxon is labelled with an order's name would match the species probe below,
  // and the order's page would then show that one recording.
  const rank = String((await _taxonomy().catch(() => null))?.get(name)?.rank ?? '').toLowerCase();
  if (_RANK_FIELDS.includes(rank) && rank !== 'taxon') return { [rank]: name };

  // Matched against the joined rows, not the taxonomy table: the question is
  // "do any RECORDINGS sit at this rank", which is what the old six parallel
  // recordingstaxa probes asked. Checking the taxonomy table instead would
  // resolve e.g. "Insecta" to {taxon:'Insecta'} — a real row there, but no
  // recording carries it as its own taxon, so the page would come back empty.
  // Free in practice: the caller needs these rows anyway.
  try {
    const rows = excludeTypes(await recordingRowsWithTaxonomy());
    for (const field of _RANK_FIELDS) {
      if (rows.some(r => String(r[field] ?? '') === name)) return { [field]: name };
    }
  } catch {
    // Rows unavailable — fall through to treating the name as a taxon.
  }
  return { taxon: name };
}

/**
 * Fetch a page of recordings for a taxon using pre-detected rank params.
 */
export async function fetchRecordingsForTaxon(rankParams, page = 1) {
  // /data/recordings/ cannot filter by rank, and its `taxon` filter is a
  // fulltext OR that cannot match a multi-word name exactly, so both the rank
  // and the exact-taxon case are resolved against the joined row cache.
  const [field, value] = Object.entries(rankParams ?? {})[0] ?? ['taxon', ''];
  const rows    = excludeTypes(await recordingRowsWithTaxonomy());
  const want    = String(value).toLowerCase();
  const matched = rows.filter(r => String(r[field] ?? '').toLowerCase() === want);
  return _page(matched, page);
}

/**
 * Fetch trait data for a taxon from the configured source.
 * @param {object} [opts]
 * @param {string} [opts.taxon]     scientific name (contains match)
 * @param {string} [opts.call_type] call type filter (contains match)
 * @param {string} [opts.sex]       sex filter (contains match)
 * @param {number} [opts.page=1]
 * @returns {Promise<{data: object[], last_page: number}>}
 */
export function fetchTraits({ taxon, trait, value, call_type, sex, page = 1, page_size } = {}) {
  return ab().traits({
    taxon:     taxon     || undefined,
    trait:     trait     || undefined,
    value:     value     || undefined,
    call_type: call_type || undefined,
    sex:       sex       || undefined,
    page,
    page_size,
  });
}

/**
 * Fetch traits for a taxon using pre-detected rank params (e.g. { family: 'Gryllidae' }).
 * Uses /data/traitstaxa/ so higher-rank pages include traits from all child taxa.
 */
export function fetchTraitsForTaxon(rankParams, page = 1) {
  return ab().traitsTaxa({ ...rankParams, page });
}

/**
 * Total annotation count for the configured source.
 * Tries dataCounts first; falls back to /data/annomate/ last_page × 50.
 * @returns {Promise<number>}
 */
export async function fetchAnnotationsCount() {
  const counts = await _sharedCounts();
  const n = Number(counts.annotations ?? counts.annomate ?? 0);
  if (n > 0) return n;
  const res = await ab().annotations({ page: 1 });
  return (res.last_page ?? 1) * 50;
}

/**
 * Fetch annotation data from ann-o-mate.
 * @param {object} [opts]
 * @param {string} [opts.taxon]         taxon name (contains match)
 * @param {string} [opts.type]          annotation type (contains match)
 * @param {string} [opts.annotator]     annotator name (contains match)
 * @param {string} [opts.annotation_id] annotation ID
 * @param {number} [opts.page=1]
 * @param {number} [opts.page_size]
 * @returns {Promise<{data: object[], last_page: number}>}
 */
export function fetchAnnotations({ taxon, type, annotator, annotation_id, page = 1, page_size } = {}) {
  return ab().annotations({
    taxon:         taxon         || undefined,
    type:          type          || undefined,
    annotator:     annotator     || undefined,
    annotation_id: annotation_id || undefined,
    page,
    page_size,
  });
}

// The source's annotations with the taxonomy joined on by taxon name, for the
// Annotations tabs of higher-rank taxa. /data/annomate/ rows carry no rank.
let _allAnnotationsPromise = null;
function _annotationRowsWithTaxonomy() {
  if (!_allAnnotationsPromise) {
    _allAnnotationsPromise = Promise.all([_fetchAll(ab().annotations), _taxonomy()])
      .then(([rows, byTaxon]) => _withTaxonomy(rows, byTaxon))
      .catch(err => { _allAnnotationsPromise = null; throw err; });
  }
  return _allAnnotationsPromise;
}

/**
 * Fetch the annotations of a taxon, by its rank params as fetchTraitsForTaxon
 * takes them. A species' own are matched by name. A higher rank's are those of
 * every taxon under it, matched on the joined rows.
 * @param {object} rankParams  e.g. { order: 'Anura' } or { taxon: 'Leptobrachella parva' }
 * @param {number} [page=1]
 * @returns {Promise<{data: object[], last_page: number}>}
 */
export async function fetchAnnotationsForTaxon(rankParams, page = 1) {
  const [field, value] = Object.entries(rankParams ?? {})[0] ?? ['taxon', ''];
  if (field === 'taxon') return ab().annotations({ taxon: value, page });
  const rows = await _annotationRowsWithTaxonomy();
  const want = String(value).toLowerCase();
  return _page(rows.filter(r => String(r[field] ?? '').toLowerCase() === want), page);
}

/**
 * Fetch all annotations for a single recording by its source_id.
 * Returns all pages up to 250 annotations.
 * @param {string|number} id  recording ID within the source
 * @returns {Promise<object[]>}
 */
export async function fetchAnnotationsForRecording(id) {
  // Keyed by id alone: recording_source is always config.source here.
  const key = String(id);
  const hit = _annotationsCache.get(key);
  if (hit !== undefined) return hit;
  // source_id is only unique within recording_source: a corpus marking
  // xeno-canto's XC17308 also files it under 17308. The pinned `source` is the
  // annotation's source, not the recording's, so name the recording's too.
  const res = await ab().annotations({
    source_id: key, recording_source: config.source, page_size: 250,
  });
  const rows = res.data ?? [];
  _annotationsCache.set(key, rows);
  return rows;
}

/**
 * Fetch BirdNET identifications for a single recording.
 * @param {string|number} id  recording ID within the source
 * @returns {Promise<object[]>}
 */
export async function fetchBirdNetAnnotations(id) {
  const key = String(id);
  const hit = _birdnetCache.get(key);
  if (hit !== undefined) return hit;
  const res = await ab().birdnetSelections({ id: key, page_size: 250 });
  const rows = res.data ?? [];
  _birdnetCache.set(key, rows);
  return rows;
}

// ── Recordings map ──────────────────────────────────────────────────
// A recording is placed where the specimen it is of was collected: the
// specimen's own coordinates, not where the recording was made. A recording
// whose specimens have none cannot be placed, so it is counted as unplaced.
// js/map.js draws the result.

const ASSOCIATED_SPECIMEN = 'http://rs.tdwg.org/ac/terms/associatedSpecimenReference';

// Recording rows are fetched by id, this many to a request.
const RECORDING_IDS_PER_REQUEST = 100;

// A specimen row's coordinates as numbers, or null where they are not a usable
// place: missing, out of range, or the 0,0 that a blank often becomes.
function _coords(row) {
  const lat = parseFloat(row.decimalLatitude);
  const lon = parseFloat(row.decimalLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

let _specimenMapPromise = null;

/**
 * The recordings that are of a specimen with coordinates, grouped by place: one
 * entry per coordinate pair, with the recordings whose specimens were collected
 * there. Cached for the session; a failure clears the cache so the next call retries.
 *
 * @returns {Promise<{points: object[], recordingCount: number, unplacedCount: number}>}
 *   unplacedCount is the number of recordings whose specimens have no coordinates.
 */
export function fetchSpecimenMap() {
  if (!_specimenMapPromise) {
    _specimenMapPromise = _buildSpecimenMap()
      .catch(err => { _specimenMapPromise = null; throw err; });
  }
  return _specimenMapPromise;
}

async function _buildSpecimenMap() {
  const [links, specimens] = await Promise.all([
    _fetchAll(ab().links, {
      subject_type: 'recordings', subject_source: config.source,
      object_type:  'specimens',  object_source:  config.source,
      predicate:    ASSOCIATED_SPECIMEN,
    }),
    _fetchAll(ab().specimens, { decimalLatitude: '-90:90', decimalLongitude: '-180:180' }),
  ]);

  // The specimens that have a place, and the recordings linked to them.
  const placed = new Map();   // specimen id -> { lat, lon, row }
  for (const s of specimens) {
    const c = _coords(s);
    if (c) placed.set(String(s.id), { ...c, row: s });
  }
  const linked = new Set(links.map(l => String(l.subject_id)));
  const pairs  = links.filter(l => placed.has(String(l.object_id)));
  const ids    = [...new Set(pairs.map(l => String(l.subject_id)))];

  // The recordings' own rows, by id, with the site's recording types left out.
  const requests = [];
  for (let i = 0; i < ids.length; i += RECORDING_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + RECORDING_IDS_PER_REQUEST);
    requests.push(ab().recordings({ id: chunk.join(','), page_size: RECORDING_IDS_PER_REQUEST }));
  }
  const responses = await Promise.all(requests);
  const recordings = new Map(
    excludeTypes(responses.flatMap(res => res.data ?? [])).map(r => [String(r.id), r]),
  );

  // One place per coordinate pair, holding the recordings whose specimens are there.
  const places = new Map();
  for (const l of pairs) {
    const rec = recordings.get(String(l.subject_id));
    if (!rec) continue;
    const sp  = placed.get(String(l.object_id));
    const key = `${sp.lat},${sp.lon}`;
    if (!places.has(key)) {
      places.set(key, { lat: sp.lat, lon: sp.lon, country: '', specimens: new Map(), recordings: new Map() });
    }
    const place = places.get(key);
    if (!place.country) place.country = sp.row.countryCode || '';
    place.specimens.set(String(sp.row.id), {
      id: sp.row.id, scientificName: sp.row.scientificName || '', eventDate: sp.row.eventDate || '',
    });
    place.recordings.set(String(rec.id), {
      id: rec.id, name: rec.name || '', taxon: rec.taxon || '', recording_type: rec.recording_type || '',
    });
  }

  const points = [...places.values()].map(p => ({
    lat: p.lat, lon: p.lon, country: p.country,
    specimens:  [...p.specimens.values()],
    recordings: [...p.recordings.values()],
  }));
  const recordingCount = new Set(points.flatMap(p => p.recordings.map(r => String(r.id)))).size;
  return { points, recordingCount, unplacedCount: linked.size - ids.length };
}

