/**
 * app.js — entry point for corpus sites
 *
 * URL scheme (works on GitHub Pages):
 *   /r/123/           recording detail: the recording's own page (tools/build-static.mjs)
 *   /t/45/            taxon view: the taxon's own page, as the build writes it
 *   ?id=123           recording detail, moved to /r/123/ once that page is found
 *   ?taxon=Gryllus    taxon view, moved to /t/<id>/ once that page is found
 *   ?q=Gryllus&p=2   search results (p defaults to 1)
 *   /                 home
 */

import config from './config.js';

import {
  fetchRecordings,
  fetchRecording,
  fetchRecordingTaxa,
  fetchRecordingCount,
  fetchTaxa,
  taxonRowsByName,
  fetchTaxaCount,
  fetchTraits,
  fetchTraitsCount,
  fetchAnnotations,
  fetchAnnotationsCount,
  fetchAnnotationsForTaxon,
  fetchAnnotationsForRecording,
  fetchBirdNetAnnotations,
  detectTaxonParams,
  fetchRecordingsForTaxon,
  fetchTraitsForTaxon,
  fetchAutocomplete,
} from './api.js';

import {
  esc,
  showLoading,
  showError,
  showEmpty,
  buildHeroWaveform,
  renderPagination,
} from './ui.js';

import { renderRecordings, renderDetail, renderTaxonomy, renderTraits, renderAnnotations, annotationRecordingLink, wireRecordingLinks, seekDetailTo, applyAnnotationRegions, applyBirdNetRegions, renderDetailAnnotations, renderDetailBirdNet, destroyDetailPlayer, staticPageHref, subgenusBrackets, ITALIC_RANKS, getField, safeUrl, UNKNOWN_TAXON, formatTimeRange } from './render.js';
import { showSpecimenMap } from './map.js';

// Must match the page size actually used for recording queries — the
// audioBlast default of 250, which api.js also pages its cached rows at.
// This is display-only: it turns last_page into an approximate total.
const RECORDS_PER_PAGE = 250;
const TRAITS_PAGE_SIZE = 50;

// Bulk-load helpers: cap concurrency so the API isn't hit with hundreds of
// simultaneous requests on browse load.
const BULK_CONCURRENCY = 6;

// Nav tokens — each navigation increments the counter for the section it
// targets. Async slot-in handlers capture the token at start and drop their
// results if the counter has moved on (= user navigated again).
const navTokens = { detail: 0, taxon: 0, search: 0 };

async function _runWithLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch (_) { results[i] = undefined; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── API call counter ──────────────────────────────────────────────
{
  const countEl = document.getElementById('api-counter-count');
  window.addEventListener('audioblast:call', e => {
    countEl.textContent = e.detail.count;
  });
}

// ── State ────────────────────────────────────────────────────────
const state = {
  query:           '',
  taxon:           '',    // current taxon page name
  taxonRankParams: null,  // cached rank params for current taxon, e.g. { class: 'Amphibia' }
  traitsFilters:       { taxon: '', trait: '', value: '', call_type: '', sex: '' },
  annotationsFilters:  { taxon: '', type: '', annotator: '' },
  browseTruncated:     '',
};

// ── DOM refs ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  pages:          document.querySelectorAll('.page'),
  navBtns:        document.querySelectorAll('nav button[data-page]'),
  heroWaveform:   $('hero-waveform'),
  homeHero:       $('home-hero'),
  searchInput:    $('main-search'),
  resultsSection: $('results-section'),
  resultsList:    $('results-list'),
  resultsCount:   $('results-count'),
  paginationCtrl: $('pagination-controls'),
  featuredSection:$('featured-section'),
  featuredList:   $('featured-list'),
  browseList:          $('browse-list'),
  detailContent:       $('detail-content'),
  taxonContent:        $('taxon-content'),
  traitsTaxonInput:    $('traits-taxon'),
  traitsTraitInput:    $('traits-trait'),
  traitsValueInput:    $('traits-value'),
  traitsCallTypeInput: $('traits-calltype'),
  traitsSexInput:      $('traits-sex'),
  traitsList:               $('traits-list'),
  traitsCount:              $('traits-count'),
  traitsPagination:         $('traits-pagination'),
  annotationsTaxonInput:    $('annotations-taxon'),
  annotationsTypeInput:     $('annotations-type'),
  annotationsAnnotatorInput:$('annotations-annotator'),
  annotationsList:          $('annotations-list'),
  annotationsCount:         $('annotations-count'),
  annotationsPagination:    $('annotations-pagination'),
  mapCanvas:                $('map-canvas'),
  mapCount:                 $('map-count'),
  mapNote:                  $('map-note'),
  statRecordings:  $('stat-recordings'),
  statTaxa:        $('stat-taxa'),
  statTraits:      $('stat-traits'),
  statAnnotations: $('stat-annotations'),
};

// ── URL helpers ───────────────────────────────────────────────────

// The site's root, as a path: the app's own addresses are relative to it. It is the
// page's base, which a shell and the static pages both set to the site's root.
const SITE_ROOT = new URL('./', document.baseURI).pathname;

// The id of the page the address is, for one kind of page ('r' or 't') under
// the site root, or null.
function _pageIdFromPath(kind) {
  const rel = location.pathname.startsWith(SITE_ROOT) ? location.pathname.slice(SITE_ROOT.length) : '';
  return new RegExp(`^${kind}/([A-Za-z0-9_-]+)/?(index\\.html)?$`).exec(rel)?.[1] ?? null;
}
const recordingIdFromPath = () => _pageIdFromPath('r');
const taxonIdFromPath = () => _pageIdFromPath('t');

// The taxon that a taxon's own page is for, found by the id in its address. The
// build writes the name on the page too, for when the taxa cannot be loaded.
async function taxonNameForPage() {
  const id = taxonIdFromPath();
  if (!id) return null;
  const rows = await taxonRowsByName().catch(() => null);
  for (const row of rows?.values() ?? []) {
    if (String(row.id) === id) return row.taxon;
  }
  return document.getElementById('page-taxon')?.dataset.taxon || null;
}

// Each address the app pushes is marked, so that "back" can tell an entry of
// its own from the page the visitor arrived on. It is from the site root, not
// the current path: on a taxon's page a relative query keeps that page's id, and
// then the address names two taxa.
function setUrl(params) {
  const qs = new URLSearchParams(params).toString();
  history.pushState({ inApp: true }, '', qs ? `${SITE_ROOT}?${qs}` : SITE_ROOT);
}

// ── Page switcher (DOM only, no URL change) ───────────────────────

function applyPage(name) {
  if (name !== 'detail') {
    destroyDetailPlayer();
    // Invalidate any in-flight detail load — its slot-in handlers will no-op.
    navTokens.detail++;
  }
  // The views for a recording and for a taxon set their own titles.
  if (name !== 'detail' && name !== 'taxon') document.title = siteTitle();
  if (name !== 'taxon') navTokens.taxon++;
  if (name !== 'home')  navTokens.search++;
  els.pages.forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  els.navBtns.forEach(b => {
    const active = b.dataset.page === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else        b.removeAttribute('aria-current');
  });
}

// Navigate to a named non-content page (browse, about, traits) and update URL.
function showPage(name) {
  applyPage(name);
  setUrl(name === 'home' ? {} : { page: name });
  if (name === 'browse')      loadBrowse().then(() => { if (state.taxon) _scrollToTaxon(state.taxon); });
  if (name === 'about')       loadAbout();
  if (name === 'traits')      loadTraitsPage(1);
  if (name === 'annotations') loadAnnotationsPage(1);
  if (name === 'map')         loadMapPage();
}

// The recordings map, drawn the first time its page opens and only resized after
// (js/map.js).
function loadMapPage() {
  showSpecimenMap({ canvas: els.mapCanvas, count: els.mapCount, note: els.mapNote }, openDetail);
}

// Clear search and return to the normal front page.
function goHome() {
  state.query = '';
  // Drop the last-visited taxon too, so visiting Browse from home doesn't
  // auto-scroll to a species the user hasn't been looking at this session.
  state.taxon = '';
  state.taxonRankParams = null;
  els.searchInput.value = '';
  els.homeHero.style.display = '';
  els.featuredSection.style.display = '';
  els.resultsSection.style.display = 'none';
  applyPage('home');
  setUrl({});
}

// ── Header stats ─────────────────────────────────────────────────
async function loadHeaderStats() {
  const [recs, taxa, traits, annotations] = await Promise.allSettled([
    fetchRecordingCount(),
    fetchTaxaCount(),
    fetchTraitsCount(),
    fetchAnnotationsCount(),
  ]);
  if (recs.status         === 'fulfilled') els.statRecordings.innerHTML  = `<strong>${recs.value.toLocaleString()}</strong>recordings`;
  if (taxa.status         === 'fulfilled') els.statTaxa.innerHTML        = `<strong>${taxa.value.toLocaleString()}</strong>taxa`;
  if (traits.status       === 'fulfilled') els.statTraits.innerHTML      = `<strong>${traits.value.toLocaleString()}</strong>traits`;
  if (annotations.status  === 'fulfilled') els.statAnnotations.innerHTML = `<strong>${annotations.value.toLocaleString()}</strong>annotations`;
}

// ── Featured recordings (homepage) ───────────────────────────────
const FEATURED_COUNT = 3;
async function loadFeatured() {
  showLoading(els.featuredList, 'Loading recordings…');
  try {
    const { data = [] } = await fetchRecordings({ page: 1, page_size: FEATURED_COUNT });
    renderRecordings(data.slice(0, FEATURED_COUNT), els.featuredList, openDetail);
  } catch (e) {
    showError(els.featuredList, `Could not load recordings: ${e.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function _formatRecordCount(page, last_page, dataLength, pageSize = RECORDS_PER_PAGE) {
  const lp = last_page || 1;
  if (page === lp) return ((lp - 1) * pageSize + dataLength).toLocaleString();
  return `~${(lp * pageSize).toLocaleString()}`;
}

// ── Search ───────────────────────────────────────────────────────
let _debounce;

function onSearchInput() {
  clearTimeout(_debounce);
  if (els.searchInput.value.trim().length > 2) {
    _debounce = setTimeout(() => search(1), 450);
  }
}

function onSearchKey(e) {
  if (e.key === 'Enter') {
    // If autocomplete has an active selection, let its handler take over
    const ac = els.searchInput.parentElement?.querySelector('.autocomplete-dropdown');
    if (ac && ac.style.display !== 'none' && ac.querySelector('.ac-active')) return;
    search(1);
  }
}


async function search(page = 1, { pushUrl = true } = {}) {
  const q = els.searchInput.value.trim();
  state.query = q;
  const token = ++navTokens.search;
  const isCurrent = () => navTokens.search === token;

  applyPage('home');
  els.homeHero.style.display = 'none';
  els.featuredSection.style.display = 'none';
  els.resultsSection.style.display = 'block';

  if (pushUrl) {
    const urlParams = {};
    if (q) urlParams.q = q;
    if (page > 1) urlParams.p = page;
    setUrl(urlParams);
  }

  showLoading(els.resultsList, 'Searching…');
  els.paginationCtrl.innerHTML = '';
  els.resultsCount.innerHTML = '';

  try {
    const { data = [], last_page = 1 } = await fetchRecordings({ taxon: q, page });
    if (!isCurrent()) return; // newer search superseded us

    const countStr = _formatRecordCount(page, last_page, data.length);
    const label = q ? ` matching <em style="color:var(--text2)">"${esc(q)}"</em>` : '';
    els.resultsCount.innerHTML =
      `<strong>${countStr}</strong> recordings${label}`;

    renderRecordings(data, els.resultsList, openDetail);
    renderPagination(els.paginationCtrl, last_page, page, p => search(p));
  } catch (e) {
    if (isCurrent()) showError(els.resultsList, `Search failed: ${e.message}`);
  }
}

// ── Detail view ──────────────────────────────────────────────────
async function _showDetail(id, fallback = null, seekTime = null) {
  const token = ++navTokens.detail;
  const isCurrent = () => navTokens.detail === token;

  showLoading(els.detailContent, 'Loading recording…');

  let rec;
  try {
    rec = await fetchRecording(id);
    if (!isCurrent()) return;
    if (!rec) {
      document.title = `Recording not found — ${config.siteName}`;
      showError(els.detailContent, 'Recording not found.');
      return;
    }
  } catch (e) {
    if (!isCurrent()) return;
    showError(els.detailContent, `Could not load recording: ${e.message}`);
    return;
  }

  // Render metadata immediately — don't wait for taxonomy or annotations.
  const shown = rec ?? fallback;
  renderDetail(shown, els.detailContent, openTaxon);
  if (seekTime != null) seekDetailTo(seekTime);
  document.title = `${shown.name || shown.taxon || 'Untitled recording'} — ${config.siteName}`;
  _useRecordingUrl(shown, seekTime, isCurrent);

  // Fetch taxonomy and annotations in parallel; slot each in when ready.
  // Every slot-in checks isCurrent() so a later navigation can't be clobbered
  // by an earlier in-flight fetch.
  fetchRecordingTaxa(id)
    .then(taxa => {
      if (!isCurrent()) return;
      renderTaxonomy(els.detailContent, taxa, openTaxon);
      const rank = (taxa?.Rank || taxa?.rank || '').toLowerCase();
      if (ITALIC_RANKS.has(rank)) {
        const subtitle = els.detailContent.querySelector('div.detail-title');
        if (subtitle) subtitle.classList.add('detail-title--italic');
      }
    })
    .catch(() => { if (isCurrent()) renderTaxonomy(els.detailContent, null, openTaxon); });

  fetchAnnotationsForRecording(id)
    .then(annotations => {
      if (!isCurrent()) return;
      applyAnnotationRegions(annotations);
      renderDetailAnnotations(els.detailContent, annotations);
    })
    .catch(() => {});

  const isSoundscape = config.soundscapeTypes?.some(
    t => t.toLowerCase() === (rec.recording_type || '').toLowerCase()
  );
  if (isSoundscape) {
    fetchBirdNetAnnotations(id)
      .then(data => {
        if (!isCurrent()) return;
        applyBirdNetRegions(data);
        renderDetailBirdNet(els.detailContent, data);
      })
      .catch(() => {});
  }
}

// Move the address to a page the build wrote for this view, once that page is
// known to exist.
async function _moveToPage(href, query, isCurrent) {
  try {
    const res = await fetch(href, { method: 'HEAD' });
    if (res.ok && isCurrent()) history.replaceState(history.state, '', href + query);
  } catch (_) { /* the address the app has still works */ }
}

// A recording's address is its own page. The build writes none for some recording
// types, and none yet for one added since the last build: those keep ?id=.
async function _useRecordingUrl(r, t, isCurrent) {
  const href = staticPageHref('r', r.id, r.recording_type);
  if (!href || recordingIdFromPath() === String(r.id)) return;
  await _moveToPage(href, t != null ? `?t=${encodeURIComponent(t)}` : '', isCurrent);
}

// A taxon's address is its own page, found by its row in the taxonomy. The row's
// rank has to match the rank the view searched by: a name can belong to taxa of
// two ranks (see _taxonPageLink).
async function _useTaxonUrl(name, rankParams, page, isCurrent) {
  const [field] = Object.keys(rankParams ?? {});
  const row = (await taxonRowsByName().catch(() => null))?.get(name);
  if (!row || !isCurrent()) return;
  if (taxonIdFromPath() === String(row.id)) return;
  if (field !== 'taxon' && String(row.rank ?? '').toLowerCase() !== field) return;
  const href = staticPageHref('t', row.id);
  if (href) await _moveToPage(href, page > 1 ? `?p=${page}` : '', isCurrent);
}

async function openDetail(recording) {
  applyPage('detail');
  setUrl(recording.t ? { id: recording.id, t: recording.t } : { id: recording.id });
  _showDetail(recording.id, recording, recording.t);
}

async function loadDetailById(id, t) {
  applyPage('detail');
  _showDetail(id, null, t);
}

// ── Taxon page ───────────────────────────────────────────────────
const _LOADING_INLINE = `<div class="loading" role="status" aria-live="polite" style="padding:0.5rem 0;font-size:12px"><div class="spinner" aria-hidden="true"></div>Loading…</div>`;

function _renderTaxonShell(name) {
  els.taxonContent.innerHTML = `
    <h1 class="detail-title">${esc(subgenusBrackets(name))}</h1>
    <div class="detail-grid">
      <div class="detail-main">
        <div class="taxon-tabs" role="tablist" aria-label="Taxon details">
          <button class="taxon-tab active" data-tab="recordings" role="tab"
                  id="taxon-tabbtn-recordings" aria-controls="tab-recordings"
                  aria-selected="true" tabindex="0">Recordings</button>
          <button class="taxon-tab" data-tab="traits" role="tab"
                  id="taxon-tabbtn-traits" aria-controls="tab-traits"
                  aria-selected="false" tabindex="-1">Traits</button>
          <button class="taxon-tab" data-tab="annotations" role="tab"
                  id="taxon-tabbtn-annotations" aria-controls="tab-annotations"
                  aria-selected="false" tabindex="-1">Annotations</button>
        </div>
        <div class="taxon-tab-panel" id="tab-recordings" role="tabpanel"
             aria-labelledby="taxon-tabbtn-recordings">
          <div class="results-header">
            <div class="results-count" id="taxon-count"></div>
          </div>
          <div id="taxon-recordings">${_LOADING_INLINE}</div>
          <div id="taxon-pagination" class="pagination"></div>
        </div>
        <div class="taxon-tab-panel" id="tab-traits" role="tabpanel"
             aria-labelledby="taxon-tabbtn-traits" hidden>
          <div id="traits-content">${_LOADING_INLINE}</div>
        </div>
        <div class="taxon-tab-panel" id="tab-annotations" role="tabpanel"
             aria-labelledby="taxon-tabbtn-annotations" hidden>
          <div id="annotations-content">${_LOADING_INLINE}</div>
        </div>
      </div>
      <div class="detail-side">
        <div class="sidebar-card">
          <div class="sidebar-title">Taxonomy</div>
          <div class="taxon-breadcrumb" id="taxon-links">${_LOADING_INLINE}</div>
        </div>
      </div>
    </div>`;

  _linkBrowseTaxon(name, els.taxonContent.querySelector('.detail-grid'));

  const tabButtons = [...els.taxonContent.querySelectorAll('.taxon-tab')];
  const tabPanels  = els.taxonContent.querySelectorAll('.taxon-tab-panel');

  function activate(btn, focusBtn = false) {
    tabButtons.forEach(b => {
      const isActive = b === btn;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      b.tabIndex = isActive ? 0 : -1;
    });
    tabPanels.forEach(panel => {
      panel.hidden = panel.id !== `tab-${btn.dataset.tab}`;
    });
    if (focusBtn) btn.focus();
  }

  tabButtons.forEach((btn, i) => {
    btn.addEventListener('click', () => activate(btn));
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const next = tabButtons[(i + delta + tabButtons.length) % tabButtons.length];
        activate(next, true);
      } else if (e.key === 'Home') {
        e.preventDefault();
        activate(tabButtons[0], true);
      } else if (e.key === 'End') {
        e.preventDefault();
        activate(tabButtons[tabButtons.length - 1], true);
      }
    });
  });
}

// Link a taxon to its page on the browse site, above the grid once the page is found there.
// The site has a page for most taxa, not every one, so the address is checked first. A grid the
// view has since replaced is detached, and takes nothing.
async function _linkBrowseTaxon(name, grid) {
  const href = config.browseTaxonUrl(name);
  if (!href) return;
  const found = await fetch(href, { method: 'HEAD' }).then(res => res.ok, () => false);
  if (!found) return;
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.innerHTML = `<a class="detail-action-link" href="${esc(href)}" target="_blank" rel="noopener">🌳 Taxon on ${esc(new URL(href).host)}</a>`;
  grid.before(actions);
}

async function _loadTaxonRecordings(name, page) {
  const recList   = els.taxonContent.querySelector('#taxon-recordings');
  const recCount  = els.taxonContent.querySelector('#taxon-count');
  const recPaging = els.taxonContent.querySelector('#taxon-pagination');
  const token = navTokens.taxon; // already bumped by openTaxon caller
  const isCurrent = () => navTokens.taxon === token && state.taxon === name;

  try {
    if (recList)  showLoading(recList, 'Loading recordings…');
    if (recPaging) recPaging.innerHTML = '';

    if (!state.taxonRankParams || state.taxon !== name) {
      state.taxonRankParams = await detectTaxonParams(name);
      if (!isCurrent()) return [];
    }
    const res = await fetchRecordingsForTaxon(state.taxonRankParams, page);
    if (!isCurrent()) return [];
    const data      = Array.isArray(res?.data) ? res.data : [];
    const last_page = res?.last_page ?? 1;

    const label = `<strong>${_formatRecordCount(page, last_page, data.length)}</strong>`
      + ` recordings for <span style="color:var(--text2)">${esc(name)}</span>`;
    if (recCount) recCount.innerHTML = label;
    renderRecordings(data, recList, openDetail);
    renderPagination(recPaging, last_page, page, p => {
      setUrl({ taxon: name, ...(p > 1 ? { p } : {}) });
      _loadTaxonRecordings(name, p);
    });
    _useTaxonUrl(name, state.taxonRankParams, page, isCurrent);
    return data;
  } catch (e) {
    if (recList && isCurrent()) showError(recList, `Could not load recordings: ${e.message}`);
    return [];
  }
}

function openTaxon(name, page = 1) {
  setUrl({ taxon: name, ...(page > 1 ? { p: page } : {}) });
  _showTaxon(name, page);
}

// Show a taxon's view. The address is the caller's: a taxon's own page keeps it.
function _showTaxon(name, page = 1) {
  applyPage('taxon');
  document.title = `${subgenusBrackets(name)} — ${config.siteName}`;

  const isNewTaxon = state.taxon !== name;
  state.taxon = name;
  const token = ++navTokens.taxon;
  const isCurrent = () => navTokens.taxon === token && state.taxon === name;

  if (isNewTaxon) {
    state.taxonRankParams = null;
    _renderTaxonShell(name);
  }

  // Recordings (and taxonomy + traits derived from first result).
  _loadTaxonRecordings(name, page)
    .then(data => {
      if (!isCurrent()) return;

      // Load traits once per taxon using the same rank params as recordings,
      // so higher-rank pages (genus, family, order…) include traits from all child taxa.
      if (isNewTaxon) {
        fetchTraitsForTaxon(state.taxonRankParams ?? { taxon: name })
          .then(res => {
            if (!isCurrent()) return;
            const rows = (res.data ?? []).map(t => ({
              ...t,
              call_type:      t.call_type      ?? t.callType,
              trait_ontology: t.trait_ontology ?? t.url,
              value_min:      t.value_min      ?? t.min,
              value_max:      t.value_max      ?? t.max,
            }));
            renderTraits(els.taxonContent, rows.length > 0 ? rows : null);
          })
          .catch(() => { if (isCurrent()) renderTraits(els.taxonContent, null); });

        fetchAnnotationsForTaxon(state.taxonRankParams ?? { taxon: name })
          .then(res => {
            if (!isCurrent()) return;
            renderAnnotations(els.taxonContent, res.data?.length > 0 ? res.data : null, openDetail);
          })
          .catch(() => { if (isCurrent()) renderAnnotations(els.taxonContent, null); });
      }

      if (data.length > 0) {
        fetchRecordingTaxa(data[0].id)
          .then(taxa => {
            if (!isCurrent()) return;
            renderTaxonomy(els.taxonContent, taxa, openTaxon);
            const paramField = Object.keys(state.taxonRankParams ?? {})[0] ?? '';
            const rank = (paramField === 'taxon'
              ? (taxa?.Rank || taxa?.rank || '')
              : paramField
            ).toLowerCase();
            if (ITALIC_RANKS.has(rank)) {
              const h1 = els.taxonContent.querySelector('h1.detail-title');
              if (h1) h1.classList.add('detail-title--italic');
              const subtitle = els.taxonContent.querySelector('div.detail-title');
              if (subtitle) subtitle.classList.add('detail-title--italic');
            }
          })
          .catch(() => { if (isCurrent()) renderTaxonomy(els.taxonContent, null, openTaxon); });
      } else {
        renderTaxonomy(els.taxonContent, null, openTaxon);
      }
    })
    .catch(() => { if (isCurrent()) renderTaxonomy(els.taxonContent, null, openTaxon); });
}

// ── Browse taxa ──────────────────────────────────────────────────

function _buildTaxaTree(rows, traitRows = []) {
  const taxonCounts = new Map();
  const taxonRow    = new Map();
  for (const r of rows) {
    const t = getField(r, 'taxon') || getField(r, 'Species') || '';
    if (!t || t === UNKNOWN_TAXON) continue;
    taxonCounts.set(t, (taxonCounts.get(t) || 0) + 1);
    if (!taxonRow.has(t)) taxonRow.set(t, r);
  }

  const traitCounts = new Map();
  for (const t of traitRows) {
    const taxon = t.taxon || '';
    if (taxon) traitCounts.set(taxon, (traitCounts.get(taxon) || 0) + 1);
  }

  const root = Object.create(null);

  const ensure = (parent, name, rank, count, traits) => {
    if (!parent[name]) parent[name] = { name, rank, count: 0, traits: 0, children: Object.create(null) };
    parent[name].count  += count;
    parent[name].traits += traits;
    return parent[name].children;
  };

  for (const [taxon, count] of taxonCounts) {
    const r       = taxonRow.get(taxon);
    const kingdom = getField(r, 'Kingdom') || '(Unknown)';
    const cls     = getField(r, 'Class');
    const order   = getField(r, 'Order');
    const family  = getField(r, 'Family');
    const genus   = getField(r, 'Genus');
    const rank    = getField(r, 'Rank') || getField(r, 'rank') || 'species';
    const traits  = traitCounts.get(taxon) || 0;

    let lvl = ensure(root, kingdom, 'Kingdom', count, traits);
    if (cls)    lvl = ensure(lvl, cls,    'Class',  count, traits);
    if (order)  lvl = ensure(lvl, order,  'Order',  count, traits);
    if (family) lvl = ensure(lvl, family, 'Family', count, traits);
    if (genus)  lvl = ensure(lvl, genus,  'Genus',  count, traits);
    if (!lvl[taxon]) lvl[taxon] = { name: taxon, rank, count, traits, children: {}, isLeaf: true };
  }

  return root;
}

function _renderTreeNode(node) {
  const rankHtml  = `<span class="tree-rank">${esc(node.rank)}</span>`;
  const italic    = ITALIC_RANKS.has(node.rank.toLowerCase());
  const countHtml = `<span class="tree-count">${node.count}</span>`;
  const traitHtml = `<span class="tree-trait-count">${node.traits > 0 ? node.traits : ''}</span>`;
  const displayName = esc(subgenusBrackets(node.name));

  if (node.isLeaf) {
    const nameHtml = `<span class="tree-name${italic ? ' tree-name--italic' : ''}">${displayName}</span>${_taxonPageLink(node)}`;
    return `<div class="taxa-leaf" data-taxon="${esc(node.name)}">${rankHtml}${nameHtml}${countHtml}${traitHtml}</div>`;
  }

  // Non-leaf: taxon name is a navigable link; clicks stop before <summary> so the
  // <details> toggle only fires when clicking the arrow, rank label, or count.
  const nameHtml = `<span class="tree-name${italic ? ' tree-name--italic' : ''} tree-name--link" data-taxon="${esc(node.name)}">${displayName}</span>${_taxonPageLink(node)}`;

  const children = Object.values(node.children)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(_renderTreeNode)
    .join('');

  return `<details class="taxa-node">
    <summary class="taxa-summary">${rankHtml}${nameHtml}${countHtml}${traitHtml}</summary>
    <div class="taxa-children">${children}</div>
  </details>`;
}

// ── Browse traits ─────────────────────────────────────────────────

function _renderTraitsTable(data, container, onTaxon) {
  if (!data || data.length === 0) {
    showEmpty(container, 'No traits found. Try different filters.');
    return;
  }

  const rows = data.map(t => {
    const taxon    = t.taxon    || '';
    const trait    = t.trait    || '';
    const ontUrl   = t.trait_ontology || '';
    const value    = t.value    != null ? String(t.value) : '—';
    const vMin     = t.value_min;
    const vMax     = t.value_max;
    const callType = t.call_type  || '—';
    const sex      = t.sex        || '—';
    const temp     = t.temperature != null ? `${t.temperature}°C` : '—';

    const safeOnt = safeUrl(ontUrl);
    const traitCell = safeOnt
      ? `<a href="${esc(safeOnt)}" target="_blank" rel="noopener" class="traits-ont-link">${esc(trait)}</a>`
      : esc(trait);

    const rangeHtml = (vMin != null || vMax != null)
      ? `<span class="traits-val-range">(${vMin ?? ''}–${vMax ?? ''})</span>`
      : '';

    return `<tr>
      <td><span class="traits-taxon-link" data-taxon="${esc(taxon)}">${esc(subgenusBrackets(taxon))}</span></td>
      <td>${traitCell}</td>
      <td><span class="traits-val-main">${esc(value)}</span>${rangeHtml}</td>
      <td class="traits-cell-dim">${esc(callType)}</td>
      <td class="traits-cell-dim">${esc(sex)}</td>
      <td class="traits-cell-dim">${esc(temp)}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="traits-browse-table">
      <thead>
        <tr>
          <th>Taxon</th>
          <th>Trait</th>
          <th>Value</th>
          <th>Call type</th>
          <th>Sex</th>
          <th>Temp</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  container.querySelectorAll('.traits-taxon-link[data-taxon]').forEach(el => {
    if (el.dataset.taxon) el.addEventListener('click', () => onTaxon(el.dataset.taxon));
  });
}

function _syncTraitsFilters() {
  const f = state.traitsFilters;
  f.taxon     = els.traitsTaxonInput.value.trim();
  f.trait     = els.traitsTraitInput.value.trim();
  f.value     = els.traitsValueInput.value.trim();
  f.call_type = els.traitsCallTypeInput.value.trim();
  f.sex       = els.traitsSexInput.value.trim();
}

async function loadTraitsPage(page = 1) {
  _syncTraitsFilters();
  const f = state.traitsFilters;

  const urlParams = { page: 'traits' };
  if (f.taxon)     urlParams.taxon    = f.taxon;
  if (f.trait)     urlParams.trait    = f.trait;
  if (f.value)     urlParams.value    = f.value;
  if (f.call_type) urlParams.calltype = f.call_type;
  if (f.sex)       urlParams.sex      = f.sex;
  if (page > 1)    urlParams.p        = page;
  setUrl(urlParams);

  showLoading(els.traitsList, 'Loading traits…');
  els.traitsPagination.innerHTML = '';
  els.traitsCount.innerHTML = '';

  try {
    const { data = [], last_page = 1 } = await fetchTraits({
      taxon:     f.taxon     || undefined,
      trait:     f.trait     || undefined,
      value:     f.value     || undefined,
      call_type: f.call_type || undefined,
      sex:       f.sex       || undefined,
      page,
      page_size: TRAITS_PAGE_SIZE,
    });

    els.traitsCount.innerHTML = `<strong>${_formatRecordCount(page, last_page, data.length, TRAITS_PAGE_SIZE)}</strong> trait measurements`;

    _renderTraitsTable(data, els.traitsList, openTaxon);
    renderPagination(els.traitsPagination, last_page, page, p => loadTraitsPage(p));
  } catch (e) {
    showError(els.traitsList, `Could not load traits: ${e.message}`);
  }
}

// ── Browse annotations ────────────────────────────────────────────

function _renderAnnotationsTable(data, container, onTaxon) {
  if (!data || data.length === 0) {
    showEmpty(container, 'No annotations found. Try different filters.');
    return;
  }

  const rows = data.map(a => {
    const taxon     = a.taxon    || '';
    const type      = a.type     || '—';
    const annotator = a.annotator || '—';
    const date      = a.annotation_date || '—';
    const timeRange = formatTimeRange(a.time_start, a.time_end);
    const infoUrl   = a.annotation_info_url || '';

    // A relative info URL (the source gives just "view") goes nowhere here
    const safeInfo = /^https?:/i.test(infoUrl) ? safeUrl(infoUrl) : '';
    const annotatorCell = safeInfo
      ? `<a href="${esc(safeInfo)}" target="_blank" rel="noopener" class="traits-ont-link">${esc(annotator)}</a>`
      : annotationRecordingLink(a, annotator);

    return `<tr>
      <td><span class="traits-taxon-link" data-taxon="${esc(taxon)}">${esc(subgenusBrackets(taxon) || '—')}</span></td>
      <td>${esc(type)}</td>
      <td>${annotatorCell}</td>
      <td class="traits-cell-dim">${timeRange ? annotationRecordingLink(a, timeRange + 's') : annotationRecordingLink(a, 'Recording')}</td>
      <td class="traits-cell-dim">${esc(date)}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="traits-browse-table">
      <thead>
        <tr>
          <th>Taxon</th>
          <th>Type</th>
          <th>Annotator</th>
          <th>Time</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  container.querySelectorAll('.traits-taxon-link[data-taxon]').forEach(el => {
    if (el.dataset.taxon) el.addEventListener('click', () => onTaxon(el.dataset.taxon));
  });
  wireRecordingLinks(container, openDetail);
}

function _syncAnnotationsFilters() {
  const f = state.annotationsFilters;
  f.taxon     = els.annotationsTaxonInput.value.trim();
  f.type      = els.annotationsTypeInput.value.trim();
  f.annotator = els.annotationsAnnotatorInput.value.trim();
}

async function loadAnnotationsPage(page = 1) {
  _syncAnnotationsFilters();
  const f = state.annotationsFilters;

  const urlParams = { page: 'annotations' };
  if (f.taxon)     urlParams.taxon     = f.taxon;
  if (f.type)      urlParams.type      = f.type;
  if (f.annotator) urlParams.annotator = f.annotator;
  if (page > 1)    urlParams.p         = page;
  setUrl(urlParams);

  showLoading(els.annotationsList, 'Loading annotations…');
  els.annotationsPagination.innerHTML = '';
  els.annotationsCount.innerHTML = '';

  try {
    const { data = [], last_page = 1 } = await fetchAnnotations({
      taxon:     f.taxon     || undefined,
      type:      f.type      || undefined,
      annotator: f.annotator || undefined,
      page,
      page_size: TRAITS_PAGE_SIZE,
    });

    els.annotationsCount.innerHTML = `<strong>${_formatRecordCount(page, last_page, data.length, TRAITS_PAGE_SIZE)}</strong> annotations`;

    _renderAnnotationsTable(data, els.annotationsList, openTaxon);
    renderPagination(els.annotationsPagination, last_page, page, p => loadAnnotationsPage(p));
  } catch (e) {
    showError(els.annotationsList, `Could not load annotations: ${e.message}`);
  }
}

// ── About page ───────────────────────────────────────────────────
let _aboutLoadPromise = null;

function loadAbout() {
  if (_aboutLoadPromise) return _aboutLoadPromise;
  const container = document.getElementById('page-about');
  _aboutLoadPromise = fetch('about.html')
    .then(r => {
      if (!r.ok) throw new Error(r.statusText);
      return r.text();
    })
    .then(html => {
      container.innerHTML = html;
      // Only the about-api-recordings element is new — set it directly instead
      // of re-running the full applyConfig() (which touches title etc.).
      const el = document.getElementById('about-api-recordings');
      if (el) el.textContent = `GET https://api.audioblast.org/data/recordings/?source=${config.source}`;
    })
    .catch(() => {
      container.innerHTML = '<div class="about-section"><p>About content could not be loaded.</p></div>';
    });
  return _aboutLoadPromise;
}

// ── Browse taxa ──────────────────────────────────────────────────

async function _fetchAllTraitRows() {
  try {
    const first = await fetchTraits({ page: 1, page_size: 250 });
    const rows = [...(first.data || [])];
    const totalPages = first.last_page || 1;
    if (totalPages > 1) {
      const tasks = Array.from({ length: totalPages - 1 }, (_, i) =>
        () => fetchTraits({ page: i + 2, page_size: 250 }).then(r => r.data || []).catch(() => [])
      );
      const rest = await _runWithLimit(tasks, BULK_CONCURRENCY);
      rows.push(...rest.flat());
    }
    return rows;
  } catch (_) {
    return [];
  }
}

let _browseLoadPromise = null;

// The source's taxa by name, set once the browse tree starts loading; it gives
// each tree row the id of its pre-built page (tools/build-static.mjs).
let _taxonPages = null;

// Link to a tree row's pre-built page, or '' where there is none. An ancestor's
// name can be shared with a taxon of another rank, so its rank has to match; a
// leaf is the taxon of its own recordings, so its name is enough.
function _taxonPageLink(node) {
  const row = _taxonPages?.get(node.name);
  if (!row) return '';
  if (!node.isLeaf && String(row.rank ?? '').toLowerCase() !== node.rank.toLowerCase()) return '';
  const href = staticPageHref('t', row.id);
  return href
    ? `<a class="tree-page-link" href="${esc(href)}" title="Page for this taxon" aria-label="Page for ${esc(node.name)}">↗</a>`
    : '';
}

// Re-render the browse tree from the current allRows + traitRows accumulators.
// Preserves <details> open/closed state across re-renders so users keeping
// branches collapsed don't lose their place when more data arrives.
function _renderBrowseTree(allRows, traitRows, progressHtml) {
  // Snapshot which nodes the user has opened so we can restore after re-render.
  const openTaxa = new Set();
  els.browseList.querySelectorAll('details.taxa-node[open] > summary .tree-name--link[data-taxon]')
    .forEach(el => openTaxa.add(el.dataset.taxon));

  const tree   = _buildTaxaTree(allRows, traitRows);
  const sorted = Object.values(tree).sort((a, b) => a.name.localeCompare(b.name));
  const html   = sorted.map(_renderTreeNode).join('');

  const truncatedNotice = state.browseTruncated
    ? `<div class="browse-truncated">${esc(state.browseTruncated)}</div>`
    : '';
  els.browseList.innerHTML = `
    ${progressHtml ?? ''}
    ${truncatedNotice}
    <div class="taxa-tree-header">
      <span class="tree-count">Recordings</span>
      <span class="tree-trait-count">Traits</span>
    </div>
    <div class="taxa-tree">${html}</div>`;

  // Open top-level kingdoms by default on first render; otherwise restore
  // the user's previous open set.
  if (openTaxa.size === 0) {
    els.browseList.querySelectorAll('.taxa-tree > .taxa-node').forEach(el => { el.open = true; });
  } else {
    els.browseList.querySelectorAll('details.taxa-node').forEach(d => {
      const link = d.querySelector('summary .tree-name--link[data-taxon]');
      if (link && openTaxa.has(link.dataset.taxon)) d.open = true;
    });
  }

  // Leaf species rows — whole row is clickable.
  els.browseList.querySelectorAll('.taxa-leaf').forEach(el => {
    el.addEventListener('click', () => openTaxon(el.dataset.taxon));
  });
  // The page links leave the app: keep the row's own click (open the taxon,
  // toggle the branch) from also firing.
  els.browseList.querySelectorAll('.tree-page-link').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });
  // Non-leaf taxon name text — navigate without toggling <details>.
  els.browseList.querySelectorAll('.tree-name--link[data-taxon]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openTaxon(el.dataset.taxon);
    });
  });
}

async function loadBrowse() {
  if (_browseLoadPromise) return _browseLoadPromise;

  _browseLoadPromise = (async () => {
    showLoading(els.browseList, 'Loading taxa…');
    try {
      // Fetch traits in parallel — will likely finish before all recording pages load.
      const traitPromise = _fetchAllTraitRows();

      const first = await fetchTaxa(1);
      _taxonPages = await taxonRowsByName().catch(() => null);
      const { last_page } = first;
      let allRows = [...first.data];

      if (!allRows.length) { showEmpty(els.browseList, 'No taxa found.'); return; }

      const BROWSE_PAGE_CAP = 100;
      const total = Math.min(last_page, BROWSE_PAGE_CAP);
      const truncated = last_page > BROWSE_PAGE_CAP;
      if (truncated) {
        state.browseTruncated = `Showing the first ${BROWSE_PAGE_CAP * 250} records (of ${last_page * 250}+). Use search or the URL filters to find taxa beyond this point.`;
      }

      // Progressive: render an initial tree from page 1 *now* so the user
      // sees a navigable list immediately, even if 99 more pages are still
      // loading in the background.
      const renderProgress = (loaded) => {
        if (loaded >= total) return '';
        const pct = Math.round((loaded / total) * 100);
        return `
          <div class="browse-progress browse-progress--inline">
            <div class="browse-progress-label">Loading more taxa… ${loaded} / ${total}</div>
            <div class="browse-progress-track"><div class="browse-progress-fill" style="width:${pct}%"></div></div>
          </div>`;
      };
      _renderBrowseTree(allRows, [], renderProgress(1));

      if (last_page > 1) {
        let loaded = 1;
        // Re-render in batches as new pages arrive — every BATCH pages, plus
        // once at the end. Reduces layout thrash compared to per-page redraws.
        const BATCH = 10;
        const tasks = Array.from({ length: total - 1 }, (_, i) =>
          () => fetchTaxa(i + 2).then(r => {
            loaded++;
            const newRows = r.data || [];
            allRows.push(...newRows);
            if (loaded === total || loaded % BATCH === 0) {
              _renderBrowseTree(allRows, [], renderProgress(loaded));
            }
            return null; // we mutate allRows directly
          }).catch(() => null)
        );
        await _runWithLimit(tasks, BULK_CONCURRENCY);
      }

      // Final pass once trait counts are in. _renderBrowseTree re-wires the
      // click listeners every call, so no extra rebinding needed here.
      const allTraitRows = await traitPromise;
      _renderBrowseTree(allRows, allTraitRows, '');
    } catch (e) {
      _browseLoadPromise = null;
      showError(els.browseList, `Could not load taxa: ${e.message}`);
    }
  })();

  return _browseLoadPromise;
}

function _scrollToTaxon(taxon) {
  const escaped = CSS.escape(taxon);
  const target  = els.browseList.querySelector(
    `.taxa-leaf[data-taxon="${escaped}"], .tree-name--link[data-taxon="${escaped}"]`
  );
  if (!target) return;

  let node = target.parentElement;
  while (node && node !== els.browseList) {
    if (node.tagName === 'DETAILS') node.open = true;
    node = node.parentElement;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('taxa-highlight');
  target.addEventListener('animationend', () => target.classList.remove('taxa-highlight'), { once: true });
}

// ── Back / forward (popstate) ─────────────────────────────────────
window.addEventListener('popstate', () => route());

// ── Router — reads URL and renders the right view ─────────────────
async function route() {
  const params = new URLSearchParams(location.search);
  const id     = params.get('id') ?? recordingIdFromPath();
  const q      = params.get('q') ?? '';
  const page   = parseInt(params.get('p') ?? '1', 10);
  const pg     = params.get('page'); // named page (browse, about)

  if (id) {
    await loadDetailById(id, params.get('t'));
    return;
  }

  // A taxon's page is found by the id in its address. ?taxon= takes precedence,
  // as ?id= does for a recording's page.
  const taxon = params.get('taxon') ?? await taxonNameForPage();
  if (taxon && pg !== 'traits' && pg !== 'annotations') {
    state.taxon = ''; // force full re-render on direct URL load
    _showTaxon(taxon, page);
    return;
  }

  if (pg === 'map') {
    applyPage('map');
    loadMapPage();
    return;
  }

  if (pg === 'browse' || pg === 'about' || pg === 'traits' || pg === 'annotations') {
    applyPage(pg);
    if (pg === 'browse') loadBrowse();
    if (pg === 'about')  loadAbout();
    if (pg === 'traits') {
      const f = state.traitsFilters;
      f.taxon     = params.get('taxon')    ?? '';
      f.trait     = params.get('trait')    ?? '';
      f.value     = params.get('value')    ?? '';
      f.call_type = params.get('calltype') ?? '';
      f.sex       = params.get('sex')      ?? '';
      els.traitsTaxonInput.value    = f.taxon;
      els.traitsTraitInput.value    = f.trait;
      els.traitsValueInput.value    = f.value;
      els.traitsCallTypeInput.value = f.call_type;
      els.traitsSexInput.value      = f.sex;
      loadTraitsPage(parseInt(params.get('p') ?? '1', 10));
    }
    if (pg === 'annotations') {
      const f = state.annotationsFilters;
      f.taxon     = params.get('taxon')     ?? '';
      f.type      = params.get('type')      ?? '';
      f.annotator = params.get('annotator') ?? '';
      els.annotationsTaxonInput.value     = f.taxon;
      els.annotationsTypeInput.value      = f.type;
      els.annotationsAnnotatorInput.value = f.annotator;
      loadAnnotationsPage(parseInt(params.get('p') ?? '1', 10));
    }
    return;
  }

  // Home / search
  applyPage('home');

  if (q) {
    els.searchInput.value = q;
    await search(page, { pushUrl: false });
  } else {
    els.homeHero.style.display = '';
    els.featuredSection.style.display = '';
    els.resultsSection.style.display = 'none';
  }
}

// ── Apply config to the DOM ───────────────────────────────────────
// The title of every page that is not a recording's.
function siteTitle() {
  return `${config.siteName} — ${config.siteTagline}`;
}

function applyConfig() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  set('footer-collection', config.siteName);
  set('browse-subtitle',   `Taxonomic index of the ${config.siteName} collection`);
  // #about-api-recordings is set by loadAbout() once that fragment is in the DOM.
}

// ── Autocomplete ─────────────────────────────────────────────────

function _setupAutocomplete(inputEl, fetchFn, onSelect) {
  const parent = inputEl.parentElement;
  const dropdown = document.createElement('div');
  dropdown.className = 'autocomplete-dropdown';
  parent.appendChild(dropdown);

  let activeIdx = -1;
  let debounce, lastQuery = '', currentList = [], _dropdownItems = [];

  function hide() {
    dropdown.style.display = 'none';
    activeIdx = -1;
  }

  function setActive(n) {
    _dropdownItems[activeIdx]?.classList.remove('ac-active');
    activeIdx = Math.max(-1, Math.min(n, _dropdownItems.length - 1));
    if (activeIdx >= 0) _dropdownItems[activeIdx].classList.add('ac-active');
  }

  function render(list) {
    if (!list.length) { hide(); return; }
    activeIdx = -1;
    currentList = list;
    dropdown.innerHTML = list
      .map(s => `<div class="autocomplete-item">${esc(s)}</div>`)
      .join('');
    _dropdownItems = [...dropdown.querySelectorAll('.autocomplete-item')];
    _dropdownItems.forEach((el, i) => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        onSelect(list[i]);
        hide();
      });
    });
    dropdown.style.display = 'block';
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = inputEl.value.trim();
    if (q.length < 2) { hide(); lastQuery = ''; return; }
    if (q === lastQuery) return;
    lastQuery = q;
    debounce = setTimeout(async () => {
      try {
        const res = await fetchFn(q);
        const raw = Array.isArray(res?.data) ? res.data : [];
        const list = raw
          .map(x => typeof x === 'string' ? x : (x.value ?? x.name ?? x.taxon ?? x.trait ?? Object.values(x).find(v => typeof v === 'string' && v) ?? String(x)))
          .filter(Boolean)
          .slice(0, 10);
        if (inputEl.value.trim() === q) render(list);
      } catch (_) {}
    }, 200);
  });

  inputEl.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown')  { e.preventDefault(); setActive(activeIdx + 1); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); setActive(activeIdx - 1); }
    if (e.key === 'Escape')     { hide(); }
    if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      onSelect(currentList[activeIdx]);
      hide();
    }
  });

  inputEl.addEventListener('blur', () => setTimeout(hide, 150));
  inputEl.addEventListener('focus', () => {
    if (inputEl.value.trim().length >= 2) lastQuery = ''; // re-trigger on re-focus
  });
}

// ── Filter input helpers ──────────────────────────────────────────

function setupFilterInputs(inputs, d, loadFn) {
  inputs.forEach(el => {
    el.addEventListener('input', () => {
      clearTimeout(d.t);
      d.t = setTimeout(() => loadFn(1), 400);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const ac = el.parentElement?.querySelector('.autocomplete-dropdown');
        if (ac && ac.style.display !== 'none' && ac.querySelector('.ac-active')) return;
        clearTimeout(d.t);
        loadFn(1);
      }
    });
  });
}

function makeOnSelect(d, loadFn) {
  return inputEl => value => {
    inputEl.value = value;
    clearTimeout(d.t);
    loadFn(1);
  };
}

// ── Boot ─────────────────────────────────────────────────────────
function init() {
  applyConfig();
  buildHeroWaveform(els.heroWaveform);
  els.searchInput.addEventListener('input', onSearchInput);
  els.searchInput.addEventListener('keydown', onSearchKey);
  $('search-btn').addEventListener('click', () => search(1));

  document.querySelectorAll('nav button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  const logoEl = $('logo-link');
  logoEl.addEventListener('click', goHome);
  logoEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); }
  });
  // Back to the results when the app pushed this entry; a visitor who arrived on
  // a recording's or a taxon's own page has no results to go back to, so goes home.
  const back = () => (history.state?.inApp ? history.back() : goHome());
  $('detail-back').addEventListener('click', back);
  $('taxon-back').addEventListener('click', back);

  const td = { t: null };
  const ad = { t: null };

  // Traits filters
  setupFilterInputs(
    [els.traitsTaxonInput, els.traitsTraitInput, els.traitsValueInput, els.traitsCallTypeInput, els.traitsSexInput],
    td, loadTraitsPage,
  );
  $('traits-search-btn').addEventListener('click', () => { clearTimeout(td.t); loadTraitsPage(1); });

  const traitsOnSelect = makeOnSelect(td, loadTraitsPage);
  // Every suggestion here has to round-trip into a /data/traits/ query, and
  // those params are exact-match — a near-miss returns nothing. So taxon and
  // trait come from the traits table itself; the recordings module suggests
  // taxa with recordings but no traits. The API rejects autocomplete on
  // traits' value/call_type/sex, but traitstaxa exposes the same two columns
  // as callType/sex. No module allows autocomplete on value, so it has none.
  _setupAutocomplete(els.traitsTaxonInput,    q => fetchAutocomplete('traits',     'taxon',    q), traitsOnSelect(els.traitsTaxonInput));
  _setupAutocomplete(els.traitsTraitInput,    q => fetchAutocomplete('traits',     'trait',    q), traitsOnSelect(els.traitsTraitInput));
  _setupAutocomplete(els.traitsCallTypeInput, q => fetchAutocomplete('traitstaxa', 'callType', q), traitsOnSelect(els.traitsCallTypeInput));
  _setupAutocomplete(els.traitsSexInput,      q => fetchAutocomplete('traitstaxa', 'sex',      q), traitsOnSelect(els.traitsSexInput));

  // Annotations filters
  setupFilterInputs(
    [els.annotationsTaxonInput, els.annotationsTypeInput, els.annotationsAnnotatorInput],
    ad, loadAnnotationsPage,
  );
  $('annotations-search-btn').addEventListener('click', () => { clearTimeout(ad.t); loadAnnotationsPage(1); });

  const annotationsOnSelect = makeOnSelect(ad, loadAnnotationsPage);
  _setupAutocomplete(els.annotationsTaxonInput,     q => fetchAutocomplete('annomate', 'taxon',     q), annotationsOnSelect(els.annotationsTaxonInput));
  _setupAutocomplete(els.annotationsTypeInput,      q => fetchAutocomplete('annomate', 'type',      q), annotationsOnSelect(els.annotationsTypeInput));
  _setupAutocomplete(els.annotationsAnnotatorInput, q => fetchAutocomplete('annomate', 'annotator', q), annotationsOnSelect(els.annotationsAnnotatorInput));

  // Autocomplete for main search. Suggestions come from `recordings`, so each
  // one has at least one recording behind it.
  _setupAutocomplete(
    els.searchInput,
    q => fetchAutocomplete('recordings', 'taxon', q),
    // A picked suggestion is an exact taxon name, but /data/recordings/ can
    // only fulltext-OR it — searching "Conocephalus Conocephalus kisi" would
    // return every Conocephalus. So open that taxon's page, which matches
    // exactly. Typed free text still goes to search() and its fulltext match.
    value => { els.searchInput.value = value; openTaxon(value); },
  );

  $('cta-search').addEventListener('click', () => els.searchInput.focus());
  $('cta-browse').addEventListener('click', () => showPage('browse'));

  loadHeaderStats();
  loadFeatured();
  route();
  _prefetchBrowseInBackground();
}

// Warm loadBrowse() without delaying boot. Three triggers; whichever fires
// first wins (loadBrowse memoises via _browseLoadPromise). The intent here is:
//
//   - Don't block the home-page critical path (boot is already done by the
//     time any of these fire).
//   - Don't make users wait when they click Browse — start loading the
//     moment they show intent (hover/focus) or earlier when the browser is
//     idle anyway.
//   - Skip the prefetch entirely if we're already on the browse/taxon path
//     (route() will handle it) or if the user has Save-Data on (mobile data).
function _prefetchBrowseInBackground() {
  if (navigator.connection?.saveData) return; // respect Save-Data header
  const pg = new URLSearchParams(location.search).get('page');
  if (pg === 'browse' || location.search.includes('taxon=')) return;

  // 1. Intent-based: user moves toward the Browse button, even briefly.
  //    `once: true` so we don't keep adding the same fetch — and loadBrowse
  //    itself is idempotent anyway.
  const browseBtn = document.querySelector('nav button[data-page="browse"]');
  if (browseBtn) {
    browseBtn.addEventListener('mouseenter', loadBrowse, { once: true, passive: true });
    browseBtn.addEventListener('focus',      loadBrowse, { once: true });
    browseBtn.addEventListener('touchstart', loadBrowse, { once: true, passive: true });
  }

  // 2. Idle-based: after the page settles, prefetch in idle time so the
  //    request doesn't compete with anything the user is actively doing.
  //    Cap the wait — don't sit on it forever if the browser never idles.
  const kick = () => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(loadBrowse, { timeout: 3000 });
    } else {
      // Safari 13.1–15.3 / older Firefox: just delay enough to clear the
      // critical-path bursts (loadHeaderStats + loadFeatured + route).
      setTimeout(loadBrowse, 2000);
    }
  };
  if (document.readyState === 'complete') kick();
  else window.addEventListener('load', kick, { once: true });
}

// ── Start ─────────────────────────────────────────────────────────
// A site calls start() with its own config, which is merged over the defaults
// in js/config.js before the page is set up. Module scripts run after parsing,
// so DOMContentLoaded may already have fired by the time this runs: check
// readyState first.
export function start(siteConfig) {
  Object.assign(config, siteConfig);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
