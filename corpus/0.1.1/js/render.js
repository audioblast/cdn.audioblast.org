/**
 * render.js — Render recording cards, detail view, waveform/spectrogram player
 *
 * Field names match the audioBlast API response for /data/recordings/, which
 * returns aliased column names — all lowercase, not the raw DB columns:
 *   id, name, taxon, filename, author, post_date, human_size, bytes, mime,
 *   recording_type, date, time, time_of_day, duration, deployment, lat, lon,
 *   license, info_url, device, source
 *
 * Rows that api.js has joined against /data/taxa/ also carry the hierarchy:
 *   kingdom, class, order, family, genus, species, rank, tribe, subfamily,
 *   suborder
 *
 * renderDetail lists whatever fields the response actually carries rather than
 * a fixed set, so columns added or renamed server-side show up without an edit
 * here — which is why the size/size_raw to human_size/bytes rename was a
 * no-op for this file.
 */

import { esc, showEmpty, ICON_PLAY, ICON_PAUSE } from './ui.js';
import { togglePlay } from './player.js';
import config from './config.js';

// Ranks whose names are italicised under the ICZN / ICN codes.
export const ITALIC_RANKS = new Set([
  'genus', 'subgenus', 'species', 'subspecies', 'variety', 'form', 'infraspecies',
]);

// Placeholder taxon string returned by the API for unidentified recordings.
export const UNKNOWN_TAXON = 'Unknown species';

// Return url unchanged if it uses a safe protocol; empty string otherwise.
// Blocks javascript:, data:, vbscript:, etc. from API-supplied URLs.
export function safeUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (/^(https?:|mailto:|\/|#|\?)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // unrecognised scheme — reject
  return s; // relative path
}

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

// Relative URL of the pre-built page for a recording or taxon
// (tools/build-static.mjs). The app is served from the site root, so it is
// relative to that. '' where the build writes no page: an unusable id, or one
// of the recording types it leaves out.
export function staticPageHref(kind, id, recordingType = '') {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id ?? ''))) return '';
  if (!config.recordingTypeAllowed(recordingType)) return '';
  return `${kind}/${id}/`;
}

// ── WaveSurfer detail player ──────────────────────────────────────
let _ws = null;
let _wsAudio = null;          // the element WaveSurfer plays from, released with the player
let _fallbackAudio = null;
let _wsCardPlayHandler = null;

// ── WaveSurfer Regions, Timeline & Spectrogram ───────────────────
let _wsRegions      = null;  // RegionsPlugin instance
let _wsTimeline     = null;  // TimelinePlugin instance
let _wsSpectrogram  = null;  // SpectrogramPlugin instance
let _wsTiles        = null;  // TiledSpectrogram plugin instance (precomputed tiles)
let _wsAnnotations  = null;  // Annotations plugin instance (boxes on the spectrogram)
let _wsRowAnnotations = [];  // the same for each row after the first, where the tiles are split by channel
let _wsReady        = false; // true after WaveSurfer fires 'ready'
let _pendingSeek    = null;  // seconds to seek to when it does, from a link with a time
let _cachedAnnotations   = null;  // the shown recording's annomate rows, kept for region re-apply
let _cachedBirdNet       = null;  // the shown recording's BirdNET rows, kept for region re-apply
let _wsRegionsList       = [];    // live Region objects so we can remove them
let _annotationsVisible  = true;  // current toggle state
let _birdnetVisible      = true;  // current toggle state

const _REGION_PALETTE = [
  'rgba(82,183,136,0.25)',
  'rgba(20,51,255,0.25)',
  'rgba(255,165,0,0.25)',
  'rgba(255,0,128,0.25)',
  'rgba(128,0,255,0.25)',
];

function _regionColor(type) {
  if (!type) return _REGION_PALETTE[0];
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return _REGION_PALETTE[h % _REGION_PALETTE.length];
}

// A palette colour without its transparency: the Annotations plugin draws a
// box's edges in it, and makes its own fills from it.
function _opaque(color) {
  return color.replace(/^rgba\((\d+),(\d+),(\d+),[\d.]+\)$/, 'rgb($1,$2,$3)');
}

// ── Lazy loader for WaveSurfer + plugins ─────────────────────────
// Loads the UMD bundle + 3 plugins from cdn.audioblast.org on first
// detail-page view, so home/browse/traits/annotations pages don't pay the
// ~300 KB JS cost. The CDN keeps each library in a folder per version, so
// a new release never changes what is loaded here.
const _WS_CDN      = 'https://cdn.audioblast.org/';
const _WS_VERSION  = '8.0.3';
const _WS_BASE     = `${_WS_CDN}wavesurfer/${_WS_VERSION}/`;
const _WS_PLUGINS  = ['plugins/regions.min.js', 'plugins/spectrogram.min.js', 'plugins/timeline.min.js'];
// The plugin that shows precomputed spectrogram tiles. It is loaded after the
// rest and on its own, so that without it the player still works, with the
// in-browser spectrogram alone. From 0.2.0 it shows the tiles of a recording
// of several channels as their mix, or one channel's.
const _WS_TILES    = `${_WS_CDN}wavesurfer-tiled-spectrogram/0.2.0/tiled-spectrogram.min.js`;
// The plugin that shows annotations: each one's span of time on the waveform,
// and a box on the spectrogram for one bounded in frequency too. Also loaded
// on its own: without it, annotations are shown as regions alone.
const _WS_ANNOTATIONS = `${_WS_CDN}wavesurfer-annotations/0.3.0/annotations.min.js`;
// How deep a box's fill is at rest, over the spectrogram: the plugin's own, 0.12,
// is too faint to see on it
const _BOX_FILL_OPACITY = 0.2;

let _wavesurferReady = null;
function _loadWaveSurfer() {
  if (typeof WaveSurfer !== 'undefined') return Promise.resolve();
  if (_wavesurferReady) return _wavesurferReady;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src   = src;
      s.async = false; // preserve execution order across multiple injections
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  // Core must finish before plugins (they read window.WaveSurfer at parse time).
  _wavesurferReady = loadScript(_WS_BASE + 'wavesurfer.min.js')
    .then(() => Promise.all(_WS_PLUGINS.map(p => loadScript(_WS_BASE + p))))
    .then(() => loadScript(_WS_TILES).catch(() => {}))
    .then(() => loadScript(_WS_ANNOTATIONS).catch(() => {}));
  return _wavesurferReady;
}

// Look up a WaveSurfer plugin class registered by the UMD builds. Each
// plugin attaches itself as both WaveSurfer.<Name> and a bare global; we try
// both so alternative builds still work.
function _getWsPlugin(name) {
  const ws = typeof WaveSurfer !== 'undefined' ? WaveSurfer : null;
  if (ws?.[name])             return ws[name];
  if (ws?.[name + 'Plugin'])  return ws[name + 'Plugin'];
  const bare       = typeof window !== 'undefined' ? window[name] : undefined;
  const barePlugin = typeof window !== 'undefined' ? window[name + 'Plugin'] : undefined;
  return bare ?? barePlugin ?? null;
}

function _makeRegionLabel(text) {
  const el = document.createElement('div');
  el.textContent = String(text).slice(0, 30);
  // Inline styles so the label is legible regardless of shadow-DOM boundary
  Object.assign(el.style, {
    fontFamily:      "'Cascadia Code','Fira Code','SF Mono',Consolas,monospace",
    fontSize:        '9px',
    lineHeight:      '1.5',
    color:           '#1a1a2e',
    background:      'rgba(250,252,250,0.88)',
    padding:         '1px 5px',
    borderRadius:    '0 3px 3px 0',
    border:          '1px solid rgba(0,0,0,0.10)',
    whiteSpace:      'nowrap',
    overflow:        'hidden',
    textOverflow:    'ellipsis',
    pointerEvents:   'none',
    letterSpacing:   '0.02em',
    boxShadow:       '0 1px 4px rgba(0,0,0,0.12)',
    maxWidth:        '95%',
    position:        'absolute',
    top:             '3px',
    left:            '0',
  });
  return el;
}

function _normalizeBirdNetForRegions(data) {
  return data.map(b => ({ type: b.taxon || 'BirdNET', time_start: b.time_start, time_end: b.time_end }));
}

function _reapplyVisibleRegions() {
  if (!_wsRegions) return;
  _clearRegions();
  if (_annotationsVisible && _cachedAnnotations?.length) _applyRegions(_cachedAnnotations, 'annotation');
  if (_birdnetVisible && _cachedBirdNet?.length)         _applyRegions(_normalizeBirdNetForRegions(_cachedBirdNet), 'birdnet');
}

// A frequency bound in Hz, from the API's text or number; null where it is
// missing or not a number, as the Annotations plugin reads it.
function _freqBound(v) {
  return (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);
}

// An annomate row, or a BirdNET one made to look like one, as the Annotations
// plugin takes it. A missing end is half a second on, as the regions drawn
// below make it; frequency bounds are passed on as they are, missing or not,
// except that an annomate row with neither (`spanFrequencies`) gets 0 Hz, the
// bottom of every spectrogram here, as its low bound. The plugin draws no box
// without a bound, and runs a missing high one to the top of the spectrogram
// shown, so such a row is a box across all of it, which moves with the
// frequency axis. A channel is passed on too: an annotation without one is
// shown on every channel.
function _toAnnotation(a, id, spanFrequencies = false) {
  const start = parseFloat(a.time_start);
  const end   = parseFloat(a.time_end);
  if (!isFinite(start)) return null;
  const unbounded = spanFrequencies && _freqBound(a.freq_low) === null && _freqBound(a.freq_high) === null;
  return {
    id,
    start,
    end:     isFinite(end) ? end : start + 0.5,
    low:     unbounded ? 0 : a.freq_low,
    high:    a.freq_high,
    channel: a.channel,
    label:   a.type || '',
    color:   _opaque(_regionColor(a.type)),
  };
}

function _applyRegions(annotations, kind) {
  if (!_wsRegions || !annotations?.length) return;
  // With the Annotations plugin, each one is a region on the waveform, as
  // without it, and an annotation is also a box on the spectrogram: bounded in
  // frequency, or across all of it with no bounds. A BirdNET identification has
  // no frequency, so it stays a region alone.
  if (_wsAnnotations) {
    const list = annotations.map((a, i) => _toAnnotation(a, `${kind}-${i}`, kind === 'annotation')).filter(Boolean);
    for (const plugin of [_wsAnnotations, ..._wsRowAnnotations]) plugin.addAll(list);
    return;
  }
  for (const a of annotations) {
    const start = parseFloat(a.time_start);
    const end   = parseFloat(a.time_end);
    if (!isFinite(start)) continue;
    try {
      const region = _wsRegions.addRegion({
        start,
        end:     isFinite(end) ? end : start + 0.5,
        color:   _regionColor(a.type),
        drag:    false,
        resize:  false,
        content: a.type ? _makeRegionLabel(a.type) : undefined,
      });
      _wsRegionsList.push(region);
    } catch (_) {}
  }
}

function _clearRegions() {
  for (const plugin of [_wsAnnotations, ..._wsRowAnnotations]) plugin?.clear();
  for (const r of _wsRegionsList) { try { r.remove(); } catch (_) {} }
  _wsRegionsList = [];
}

function _toggleAnnotations(container, checked) {
  _annotationsVisible = checked;
  const block = container.querySelector('#detail-annotations-block');
  if (block) block.style.display = _annotationsVisible ? '' : 'none';
  _reapplyVisibleRegions();
}

function _toggleBirdNet(container, checked) {
  _birdnetVisible = checked;
  const block = container.querySelector('#detail-birdnet-block');
  if (block) block.style.display = _birdnetVisible ? '' : 'none';
  _reapplyVisibleRegions();
}

// "12.5–17.0" if both ends present, "12.5" if only start, "" if neither.
export function formatTimeRange(start, end) {
  return [start, end].filter(v => v != null).join('–');
}

// "2.73 kHz–8.15 kHz", "from 9.8 kHz" or "up to 4 kHz" from bounds in Hz,
// which the API gives as text; "" for an annotation bounded in time alone.
function _formatFreqRange(low, high) {
  const show = v => Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
  const l = _freqBound(low), h = _freqBound(high);
  if (l != null && h != null) return `${show(l)}–${show(h)}`;
  if (l != null) return `from ${show(l)}`;
  if (h != null) return `up to ${show(h)}`;
  return '';
}

// Build the `data-seek="…"` + style/title attrs for a row whose start time is
// numeric; empty string otherwise.
function _seekAttrs(timeStart) {
  const t = parseFloat(timeStart);
  return isFinite(t) ? ` data-seek="${t}" style="cursor:pointer" title="Jump to ${t}s"` : '';
}

// Wire click-to-seek on all `tr[data-seek]` rows inside `block`. Clicks on
// nested links inside the row are ignored.
function _wireSeekRows(block) {
  block.querySelectorAll('tr[data-seek]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const t = parseFloat(tr.dataset.seek);
      if (_ws) _ws.setTime(t);
      else if (_fallbackAudio) _fallbackAudio.currentTime = t;
    });
  });
}

/**
 * Apply annotation regions to the active WaveSurfer player.
 * Safe to call before or after WaveSurfer fires 'ready'.
 * @param {object[]} annotations  rows from /data/annomate/
 */
export function applyAnnotationRegions(annotations) {
  if (!annotations?.length) return;
  _cachedAnnotations = annotations;
  if (!_annotationsVisible) return;
  if (_wsReady && _wsRegions) _reapplyVisibleRegions();
}

/**
 * Apply BirdNET identification regions to the active WaveSurfer player.
 * Safe to call before or after WaveSurfer fires 'ready'.
 * @param {object[]} data  rows from /analysis/birdnet_selection/
 */
export function applyBirdNetRegions(data) {
  if (!data?.length) return;
  _cachedBirdNet = data;
  if (!_birdnetVisible) return;
  if (_wsReady && _wsRegions) _reapplyVisibleRegions();
}

/**
 * Render annotations as a table in the detail view, directly below the audioBlast actions row.
 * @param {HTMLElement} container  the same container passed to renderDetail
 * @param {object[]|null} annotationData  rows from /data/annomate/
 */
export function renderDetailAnnotations(container, annotationData) {
  const block = container.querySelector('#detail-annotations-block');
  if (!block) return;

  const toggleBtn = container.querySelector('.ws-ann-toggle');

  if (!annotationData || annotationData.length === 0) {
    block.innerHTML = '';
    if (toggleBtn) toggleBtn.style.display = 'none';
    return;
  }

  if (toggleBtn) toggleBtn.style.display = '';
  if (block) block.style.display = _annotationsVisible ? '' : 'none';

  // A Frequency column only where some annotation is bounded in frequency
  const hasFreq = annotationData.some(a => _formatFreqRange(a.freq_low, a.freq_high));

  const rows = annotationData.map(a => {
    const timeRange = formatTimeRange(a.time_start, a.time_end);
    return `<tr${_seekAttrs(a.time_start)}>
      <td>${esc(a.type || '—')}</td>
      <td>${esc(a.annotator || '—')}</td>
      <td>${timeRange ? esc(timeRange) + 's' : '—'}</td>
      ${hasFreq ? `<td>${esc(_formatFreqRange(a.freq_low, a.freq_high) || '—')}</td>` : ''}
    </tr>`;
  }).join('');

  block.innerHTML = `
    <h3 class="detail-section-heading">Annotations</h3>
    <table class="meta-table" style="margin-top:0.75rem">
      <thead><tr><th>Type</th><th>Annotator</th><th>Time</th>${hasFreq ? '<th>Frequency</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  _wireSeekRows(block);
}


/**
 * Render BirdNET identifications below the annotations block in the detail view.
 * @param {HTMLElement} container  the same container passed to renderDetail
 * @param {object[]|null} data  rows from /analysis/birdnet_selection/
 */
export function renderDetailBirdNet(container, data) {
  const block = container.querySelector('#detail-birdnet-block');
  if (!block) return;

  const toggleBtn = container.querySelector('.ws-birdnet-toggle');

  if (!data || data.length === 0) {
    block.innerHTML = '';
    if (toggleBtn) toggleBtn.style.display = 'none';
    return;
  }

  if (toggleBtn) toggleBtn.style.display = '';

  const rows = data.map(b => {
    const timeRange  = formatTimeRange(b.time_start, b.time_end);
    const confidence = b.confidence != null ? `${b.confidence}%` : '—';
    return `<tr${_seekAttrs(b.time_start)}>
      <td>${esc(b.taxon || '—')}</td>
      <td>${esc(confidence)}</td>
      <td>${timeRange ? esc(timeRange) + 's' : '—'}</td>
    </tr>`;
  }).join('');

  block.innerHTML = `
    <h3 class="detail-section-heading">BirdNET Identifications</h3>
    <table class="meta-table" style="margin-top:0.75rem">
      <thead><tr><th>Taxon</th><th>Confidence</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  _wireSeekRows(block);
}

function _fmt(s) {
  s = s || 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function _registerCardPlayHandler(pauseFn) {
  if (_wsCardPlayHandler) window.removeEventListener('corpus:cardplay', _wsCardPlayHandler);
  _wsCardPlayHandler = pauseFn;
  window.addEventListener('corpus:cardplay', _wsCardPlayHandler);
}

// Fallback when WaveSurfer cannot fetch audio (e.g. CORS missing on the server).
// Reuses the same play button and time elements — waveform area collapses, and
// the frequency axis is hidden, as there is no spectrogram for it to label.
function _initFallback(waveEl, btnEl, timeEl, url) {
  waveEl.innerHTML = '';
  waveEl.style.minHeight = '0';
  const freqCanvas = document.getElementById(waveEl.id.replace('ws-wave-', 'ws-freq-'));
  if (freqCanvas) freqCanvas.style.display = 'none';
  const zoomBox = document.getElementById(waveEl.id.replace('ws-wave-', 'ws-zoom-'));
  if (zoomBox) zoomBox.hidden = true;
  const channelsBox = document.getElementById(waveEl.id.replace('ws-wave-', 'ws-channels-'));
  if (channelsBox) channelsBox.hidden = true;

  const audio = new Audio();
  audio.src = url;
  audio.preload = 'metadata';
  _fallbackAudio = audio;

  _registerCardPlayHandler(() => audio.pause());

  btnEl?.addEventListener('click', () =>
    audio.paused ? audio.play().catch(() => {}) : audio.pause()
  );
  audio.addEventListener('play', () => {
    if (btnEl) { btnEl.innerHTML = ICON_PAUSE; btnEl.classList.add('playing'); }
    document.getElementById('global-audio')?.pause();
    window.dispatchEvent(new Event('corpus:waveplay'));
  });
  audio.addEventListener('pause', () => { if (btnEl) { btnEl.innerHTML = ICON_PLAY; btnEl.classList.remove('playing'); } });
  audio.addEventListener('ended', () => { if (btnEl) { btnEl.innerHTML = ICON_PLAY; btnEl.classList.remove('playing'); } });
  audio.addEventListener('timeupdate', () => {
    if (!timeEl) return;
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    timeEl.textContent = `${_fmt(audio.currentTime)} / ${_fmt(dur)}`;
  });
  audio.addEventListener('loadedmetadata', () => {
    if (timeEl && isFinite(audio.duration)) timeEl.textContent = `0:00 / ${_fmt(audio.duration)}`;
  });
}

/**
 * Read the sample rate directly from the first bytes of an audio file.
 * Supports WAV (RIFF), FLAC, OGG/Vorbis, and MP3 (with or without ID3v2).
 * Returns null when the format is unrecognised or the request fails.
 * Uses a Range request so only 256 bytes are transferred.
 */
async function _readFileSampleRate(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-255' } });
    if (!res.ok && res.status !== 206) return null;
    const b = new Uint8Array(await res.arrayBuffer());

    // ── WAV (RIFF….WAVE) ─────────────────────────────────────────────────────
    // The `fmt ` chunk is usually but not always at offset 12 — broadcast WAV
    // files prepend a `bext` chunk, some recorders add `JUNK`, etc. Walk the
    // chunk list to find `fmt ` instead of trusting the fixed offset.
    if (b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46 &&
        b[8]===0x57&&b[9]===0x41&&b[10]===0x56&&b[11]===0x45) {
      let off = 12;
      while (off + 8 <= b.length) {
        const id = String.fromCharCode(b[off], b[off+1], b[off+2], b[off+3]);
        const size = b[off+4] | (b[off+5]<<8) | (b[off+6]<<16) | (b[off+7]<<24);
        if (id === 'fmt ' && off + 16 <= b.length) {
          const sr = b[off+12] | (b[off+13]<<8) | (b[off+14]<<16) | (b[off+15]<<24);
          return sr > 0 ? sr : null;
        }
        // Chunks are word-aligned; bump odd sizes up by one.
        off += 8 + size + (size & 1);
      }
      return null;
    }

    // ── FLAC ─────────────────────────────────────────────────────────────────
    if (b[0]===0x66&&b[1]===0x4C&&b[2]===0x61&&b[3]===0x43) {
      // STREAMINFO block: bits 80-99 = sample rate (20 bits, big-endian)
      const sr = ((b[18]<<12)|(b[19]<<4)|(b[20]>>4)) & 0xFFFFF;
      return sr > 0 ? sr : null;
    }

    // ── OGG / Vorbis ─────────────────────────────────────────────────────────
    if (b[0]===0x4F&&b[1]===0x67&&b[2]===0x67&&b[3]===0x53) {
      // Search for Vorbis identification header packet (starts with 0x01 "vorbis")
      for (let i = 28; i < b.length - 14; i++) {
        if (b[i]===0x01 && b[i+1]===0x76&&b[i+2]===0x6F&&b[i+3]===0x72 &&
            b[i+4]===0x62&&b[i+5]===0x69&&b[i+6]===0x73) {
          const sr = b[i+11]|(b[i+12]<<8)|(b[i+13]<<16)|(b[i+14]<<24);
          return sr > 0 ? sr : null;
        }
      }
    }

    // ── MP3 (MPEG Audio) ─────────────────────────────────────────────────────
    let start = 0;
    // Skip ID3v2 tag if present
    if (b[0]===0x49&&b[1]===0x44&&b[2]===0x33) {
      const id3len = ((b[6]&0x7F)<<21)|((b[7]&0x7F)<<14)|((b[8]&0x7F)<<7)|(b[9]&0x7F);
      start = 10 + id3len;
    }
    // Find a valid MPEG frame header. The sync word `0xFF 0xEx` is only 11
    // bits — it can appear by chance inside arbitrary data, so we validate
    // the rest of the header (layer, bitrate index, sample-rate index) and
    // require *two* consecutive valid frame headers spaced by the frame's
    // own length. That eliminates almost all false positives.
    const SR = { 3:[44100,48000,32000], 2:[22050,24000,16000], 0:[11025,12000,8000] };
    const BR_MPEG1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
    const BR_MPEG2_L3 = [0, 8,16,24,32,40,48,56, 64, 80, 96,112,128,144,160];
    function parseHeader(o) {
      if (o + 3 >= b.length) return null;
      if (b[o] !== 0xFF || (b[o+1] & 0xE0) !== 0xE0) return null;
      const ver   = (b[o+1] >> 3) & 3;            // 0=2.5, 2=2, 3=1
      const layer = (b[o+1] >> 1) & 3;            // 1=III, 2=II, 3=I
      const briIx = (b[o+2] >> 4) & 0xF;
      const sriIx = (b[o+2] >> 2) & 3;
      const pad   = (b[o+2] >> 1) & 1;
      if (ver === 1 || layer === 0) return null;  // reserved
      if (briIx === 0 || briIx === 0xF) return null; // free/bad
      if (sriIx === 3) return null;               // reserved
      const sr = SR[ver][sriIx];
      const br = (ver === 3 ? BR_MPEG1_L3 : BR_MPEG2_L3)[briIx] * 1000;
      if (!sr || !br) return null;
      const samplesPerFrame = (ver === 3) ? 1152 : 576;
      const frameLen = Math.floor(samplesPerFrame * br / 8 / sr) + pad;
      return { sr, frameLen };
    }
    for (let i = start; i < b.length - 3; i++) {
      const h = parseHeader(i);
      if (!h) continue;
      // Confirm with a second header at i + frameLen — eliminates the false
      // positives that come from data that *looks* like a sync word.
      const h2 = parseHeader(i + h.frameLen);
      if (h2 && h2.sr === h.sr) return h.sr;
    }
  } catch (_) {}
  return null;
}

// WaveSurfer decodes at the rate it's given, not the file's own — it defaults
// to 8 kHz, which cuts the spectrogram off at 4 kHz. Decoded audio is float32
// for every channel, so long recordings get a lower rate (never below that old
// 8 kHz) instead of gigabytes of memory.
const WS_DECODE_BUDGET = 64e6; // decoded samples across all channels (~256 MB)

/**
 * Choose the rate WaveSurfer decodes at: the file's own, capped by the memory
 * budget, then stepped down to a rate this browser's AudioContext accepts
 * (the Web Audio spec only guarantees 8–96 kHz). OfflineAudioContext has the
 * same limits and is cheap to construct, so it serves as the probe.
 */
function _pickDecodeRate(fileRate, duration, channels) {
  let rate = fileRate || 48000;
  if (duration > 0) rate = Math.min(rate, WS_DECODE_BUDGET / (duration * (channels || 2)));
  rate = Math.max(8000, Math.floor(rate));
  if (typeof OfflineAudioContext === 'undefined') return rate;
  for (const r of [rate, 384000, 192000, 96000]) {
    if (r > rate) continue;
    try { new OfflineAudioContext(1, 1, r); return r; } catch (_) {}
  }
  return Math.min(rate, 96000);
}

/**
 * Try fetching a recording's precomputed peaks: a BBC audiowaveform JSON file,
 * whose URL the API gives as peaks_url.
 * Returns a channel data array (Float32Array[]), or null on failure.
 */
async function _fetchPeaks(peaksUrl) {
  try {
    const res = await fetch(peaksUrl);
    if (!res.ok) return null;
    const j = await res.json();
    if (!Array.isArray(j.data) || !j.length) return null;
    const scale    = j.bits === 8 ? 127 : 32768;
    const channels = j.channels || 1;
    const out = [];
    for (let ch = 0; ch < channels; ch++) {
      const arr = new Float32Array(j.length);
      for (let i = 0; i < j.length; i++) {
        const base = (i * channels + ch) * 2;
        arr[i] = Math.max(Math.abs(j.data[base] / scale), Math.abs(j.data[base + 1] / scale));
      }
      out.push(arr);
    }
    const duration = j.sample_rate ? j.length * j.samples_per_pixel / j.sample_rate : null;
    return { channels: out, duration };
  } catch (_) {
    return null;
  }
}

/**
 * Fetch the peaks of each of the given views of a recording's tiles (see
 * wavesurfer-tiled-spectrogram's SPEC.md), at the scale the waveform is drawn
 * at, as the channels of one set: being of the same level, they line up.
 * Returns { channels, duration }, or null where any of them can't be had.
 */
async function _fetchViewPeaks(TilesPlugin, manifest, baseUrl, views) {
  const sets = await Promise.all(views.map(index => {
    const entry = TilesPlugin.choosePeaks(manifest.views[index], WS_MIN_PX_PER_SEC);
    return entry ? _fetchPeaks(TilesPlugin.peaksUrl(entry, baseUrl)) : null;
  }));
  const lineUp = set => set?.channels.length === 1 && set.channels[0].length === sets[0].channels[0].length;
  if (!sets.every(lineUp)) return null;
  return { channels: sets.map(set => set.channels[0]), duration: sets[0].duration };
}

/**
 * Draw a waveform preview canvas from pre-computed peaks, positioned as an
 * absolute overlay inside waveEl. Removed once WaveSurfer renders for real.
 */
// Horizontal density for the WaveSurfer player; reused by the peaks preview
// so the preview width matches the rendered waveform.
const WS_MIN_PX_PER_SEC = 344;
// The waveform's height, which the waveforms of the channels shown share
const WS_WAVE_H = 128;
// How far the player zooms in, in pixels a second of the recording: a pixel is
// then a quarter of a millisecond. Zoomed right out, it shows the whole
// recording. Each press of a zoom button doubles or halves the scale.
const WS_MAX_PX_PER_SEC = 4000;
const WS_ZOOM_STEP      = 2;

/**
 * Zoom for the detail player: its buttons, and Ctrl/⌘ + wheel or a trackpad
 * pinch (which browsers report as one) over the player, about the pointer, so
 * that what is under it stays there. A plain wheel still scrolls the page.
 * Each zoom redraws the waveform and the spectrograms, so wheel steps are
 * gathered and applied at most every 40 ms.
 *
 * maxPx is how far in it goes: less than WS_MAX_PX_PER_SEC where there is
 * nothing finer to show, as when the tiles are the spectrogram. spectrogram
 * is the in-browser one, if there is one, to draw again at each new scale.
 */
function _setupZoom(ws, waveEl, signal, maxPx = WS_MAX_PX_PER_SEC, spectrogram = null) {
  const box = document.getElementById(waveEl.id.replace('ws-wave-', 'ws-zoom-'));
  let px = WS_MIN_PX_PER_SEC;   // the scale asked for
  let pending = null;           // wheel zoom gathered so far: [factor, pointer x]
  let timer = null;
  let redraw = null;

  // wavesurfer.js 8's windowed spectrogram stretches what it has drawn to a new
  // scale, and draws it again only when one zoom more than doubles or halves
  // the scale. The buttons' exact doubling and the wheel's small steps never
  // do, so zoomed in it blurs into bands, each drawn column hundreds of pixels
  // wide. So once zooming stops, what is on screen is drawn again at the scale
  // it is shown at. 8.0.2 offers no way in but what it exposes for its tests.
  function redrawSpectrogram() {
    const segments = spectrogram?.__spectrogramInternalsForTests?.()?.windowed?.segmentManager;
    if (!segments) return;
    clearTimeout(redraw);
    redraw = setTimeout(() => {
      try {
        segments.clearAllSegments();
        segments.renderVisibleWindow().catch(() => {});
      } catch (_) {}
    }, 250);
  }
  ws.on('destroy', () => clearTimeout(redraw));

  // wavesurfer.js stretches a recording that would not reach across the
  // player to fill it, so the scale drawn is never less than that. It lays the
  // recording out by the decoded audio's duration, which the media element
  // rounds to the microsecond, and rounds the width up, so the scale that fits
  // is a hair under the player's width a second of that: at exactly the
  // player's width, the recording can come out a pixel too wide, and scroll.
  const fit   = () => {
    const d = ws.getDecodedData()?.duration || ws.getDuration();
    return d > 0 ? (waveEl.clientWidth - 0.01) / d : 0;
  };
  const drawn = () => Math.max(px, fit());

  function update() {
    if (!box) return;
    const whole = drawn() <= fit() * 1.001;
    box.querySelector('[data-zoom="out"]').disabled = whole;
    box.querySelector('[data-zoom="fit"]').disabled = whole;
    box.querySelector('[data-zoom="in"]').disabled  = px >= maxPx * 0.999;
  }

  function zoomTo(want, anchorX) {
    if (!(ws.getDuration() > 0)) return;
    const next = Math.min(maxPx, Math.max(fit(), want));
    const from = drawn();
    if (Math.abs(next - from) > from * 1e-3) {
      const x  = anchorX ?? waveEl.clientWidth / 2;
      const at = (ws.getScroll() + x) / from;
      px = next;
      ws.zoom(next);
      ws.setScroll(Math.max(0, at * next - x));
      redrawSpectrogram();
    }
    update();
  }

  box?.addEventListener('click', e => {
    const how = e.target.closest('[data-zoom]')?.dataset.zoom;
    if (how === 'fit') zoomTo(0);
    else if (how) zoomTo(drawn() * (how === 'in' ? WS_ZOOM_STEP : 1 / WS_ZOOM_STEP));
  }, { signal });

  waveEl.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !(ws.getDuration() > 0)) return;
    e.preventDefault();
    // A mouse wheel's notch (100 px, or 3 lines) zooms by about 1.5 times;
    // a pinch's small steps by a little
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 40 : 1) * 0.004);
    const x = e.clientX - waveEl.getBoundingClientRect().left;
    pending = pending ? [pending[0] * f, x] : [f, x];
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        const [factor, at] = pending;
        pending = null;
        zoomTo(drawn() * factor, at);
      }, 40);
    }
  }, { passive: false, signal });

  ws.on('ready', () => {
    if (box) box.hidden = false;
    update();
  });
  // The player can change width, which moves the scale that fits
  ws.on('redraw', update);
}

/**
 * What the player can show of a recording of several channels whose tiles
 * have a view of each channel as well as of their mix: each channel's
 * waveform and spectrogram, one above another ('split', the default), one
 * composite waveform over the mix's spectrogram ('mix'), or one channel's
 * waveform over its own spectrogram (the channel, counting from 0).
 *
 * channels are those with a view, in order, and viewOf gives each one's place
 * in the tiles' views. streamed says what the waveform is drawn from: the
 * peaks of the mix and then of each channel, or else the decoded audio, whose
 * channels wavesurfer.js draws as one composite waveform when it is not split,
 * the first above the middle and the second below.
 *
 * Gives, for a choice, the tiles' view to show, whether the tiles are split
 * into a row for each channel, and wavesurfer.js's splitChannels: a height for
 * each channel of the waveform's data, those shown sharing the waveform's
 * height and the rest drawn 0 px high.
 */
function _channelChoices(channels, viewOf, streamed, channelCount) {
  // What each channel of the waveform's data is
  const data = streamed ? ['mix', ...channels] : Array.from({ length: channelCount }, (_, c) => c);
  return {
    view: choice => (choice === 'split' || choice === 'mix') ? 0 : viewOf.get(Number(choice)),
    splitTiles: choice => choice === 'split',
    split: choice => {
      if (choice === 'mix' && !streamed) return undefined;
      const shown = data.map(d => choice === 'split' ? channels.includes(d) : String(d) === choice);
      let left  = WS_WAVE_H;
      let count = shown.filter(Boolean).length;
      return shown.map(s => {
        if (!s) return { height: 0 };
        const height = Math.round(left / count);
        left  -= height;
        count -= 1;
        return { height };
      });
    },
  };
}

/**
 * The channel picker in the player's controls (see _channelChoices), shown
 * once the player is ready, which shows what is chosen: the tiles' view or
 * rows, and the waveforms.
 */
function _setupChannels(ws, waveEl, signal, tiles, channels, choices) {
  const box    = document.getElementById(waveEl.id.replace('ws-wave-', 'ws-channels-'));
  const select = box?.querySelector('select');
  if (!select) return;
  const name = (c, i) => channels.length === 2 ? ['Left channel', 'Right channel'][i] : `Channel ${c + 1}`;
  select.innerHTML = [
    '<option value="split">Split channels</option>',
    '<option value="mix">Composite</option>',
    ...channels.map((c, i) => `<option value="${c}">${name(c, i)}</option>`),
  ].join('');
  select.value = 'split';
  select.addEventListener('change', () => {
    try {
      tiles.setSplit(choices.splitTiles(select.value));
      tiles.setView(choices.view(select.value));
    } catch (_) {}
    ws.setOptions({ splitChannels: choices.split(select.value) });
  }, { signal });
  ws.on('ready', () => { box.hidden = false; });
}

function _drawPeaksPreview(waveEl, peaks, duration, split = false) {
  if (!peaks[0] || !waveEl.isConnected) return null;
  // Draw at the scale WaveSurfer will render at, so the waveform doesn't jump
  // when it takes over, but only the part in view: the whole recording at that
  // scale is far wider than a canvas can be (a 10-minute recording is ~200,000
  // px; browsers stop at 32,767 or 65,535), and nothing scrolls until
  // WaveSurfer is ready anyway.
  const visible = waveEl.clientWidth || 800;
  const full    = duration ? Math.round(duration * WS_MIN_PX_PER_SEC) : visible;
  const w   = Math.min(full, visible);
  const h   = 128;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  Object.assign(canvas.style, {
    position: 'absolute', top: '0', left: '0',
    width: w + 'px', height: h + 'px',
    zIndex: '8', pointerEvents: 'none',
  });
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // Canvas can't read CSS vars; resolve the design-token value at draw time
  // so the preview colour follows theme changes.
  ctx.fillStyle =
    getComputedStyle(document.documentElement).getPropertyValue('--text3').trim()
    || '#6c727c';
  // Drawn as WaveSurfer draws the waveform that replaces it, and scaled as its
  // `normalize` scales it: split, each channel in a band of its own, to its own
  // loudest point; else the first channel above the middle and the second below,
  // to the loudest point of both (see renderLineWaveform in wavesurfer.js).
  const loudest = chs => chs.reduce((m, ch) => ch.reduce((a, v) => Math.max(a, v), m), 0);
  const gainOf  = chs => (loudest(chs) > 0 ? 1 / loudest(chs) : 1);
  const at      = (ch, x) => ch[Math.floor(x * ch.length / full)] || 0;
  if (split) {
    const bandH = h / peaks.length;
    peaks.forEach((ch, c) => {
      const gain = gainOf([ch]);
      for (let x = 0; x < w; x++) {
        const barH = Math.max(1, at(ch, x) * gain * bandH);
        ctx.fillRect(x, c * bandH + (bandH - barH) / 2, 1, barH);
      }
    });
  } else {
    const gain = gainOf(peaks);
    const [above, below = above] = peaks;
    for (let x = 0; x < w; x++) {
      const upH   = Math.max(1, at(above, x) * gain * h / 2);
      const downH = Math.max(1, at(below, x) * gain * h / 2);
      ctx.fillRect(x, h / 2 - upH, 1, upH);
      ctx.fillRect(x, h / 2, 1, downH);
    }
  }
  waveEl.appendChild(canvas);
  return canvas;
}

/**
 * Fetch a recording's precomputed spectrogram tiles' manifest (see
 * wavesurfer-tiled-spectrogram's SPEC.md). Returns { manifest, url }, or null
 * where there is none or it can't be had, which leaves the in-browser
 * spectrogram to do on its own.
 */
async function _fetchTilesManifest(tilesUrl) {
  if (!tilesUrl) return null;
  try {
    const res = await fetch(tilesUrl);
    if (!res.ok) return null;
    return { manifest: await res.json(), url: new URL(tilesUrl, document.baseURI).href };
  } catch (_) {
    return null;
  }
}

/**
 * Draw the spectrogram's frequency axis, 0 Hz to `nyquist`, on the 55 px canvas
 * to the left of the player, `top` px down, where the spectrogram starts. Each
 * of its `rows`, `specH` px high, has the same axis: tiles split into a row for
 * each channel have one for each.
 */
function _drawFreqAxis(canvas, specH, nyquist, top, rows = 1) {
  const dpr = window.devicePixelRatio || 1;
  const height = specH * rows;
  canvas.width  = Math.round(55 * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = height + 'px';
  // Level with the spectrogram, which comes after the waveform and
  // timeline. (A horizontal scrollbar can come after the spectrogram, so
  // lining the axis up with the bottom of the player puts it too low.)
  canvas.style.marginTop = top + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fafcfa';
  ctx.fillRect(0, 0, 55, height);

  // Pick a round-number major-tick interval that keeps labels ~20 px apart.
  // Spectrograms are drawn on a LINEAR frequency scale, so label positions map
  // directly: y = (1 − freq/nyquist) × specH.
  const minGapHz = nyquist * (20 / specH);   // Hz per 20 px
  const rawStep  = minGapHz;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const nice      = [1, 2, 2.5, 5, 10];
  const stepHz    = magnitude * (nice.find(n => n * magnitude >= rawStep) ?? 10);

  ctx.font      = '8px "Cascadia Code","Fira Code",monospace';
  ctx.textAlign = 'right';

  for (let row = 0; row < rows; row++) {
    for (let freq = 0; freq <= nyquist + stepHz * 0.01; freq += stepHz / 2) {
      const isMajor = Math.round(freq / (stepHz / 2)) % 2 === 0;
      const at      = Math.round((1 - freq / nyquist) * specH);   // from the row's top
      if (at < 0 || at > specH) continue;
      const y       = row * specH + at;

      // tick — major ticks are longer
      ctx.fillStyle = isMajor
        ? 'rgba(138,144,153,0.70)'
        : 'rgba(138,144,153,0.35)';
      ctx.fillRect(isMajor ? 42 : 48, y, isMajor ? 12 : 6, 1);

      if (!isMajor) continue;

      // label text
      const label = freq >= 1000
        ? `${(freq / 1000 % 1 === 0 ? freq / 1000 : (freq / 1000).toFixed(1))}k`
        : `${Math.round(freq)}`;
      ctx.fillStyle = '#555b6e';
      // Nudge first/last labels inward so they don't clip at the canvas edge
      const ty = at < 9 ? y + 9 : y - 2;
      ctx.fillText(label, 40, ty);
    }
  }
}

// A spinner over part of the player: `top` px down, `height` px tall
function _makeSpinner(top, height) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position:       'absolute',
    top:            `${top}px`,
    left:           '0',
    right:          '0',
    height:         `${height}px`,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         '9',
    pointerEvents:  'none',
  });
  el.innerHTML = '<div class="spinner"></div>';
  return el;
}

async function _initWaveSurfer(waveEl, btnEl, timeEl, url, hints = {}) {
  // renderDetail has already destroyed the previous player and reset the
  // state that went with it.
  if (!waveEl) return;

  // The player's full height, and spinners over the waveform and timeline and
  // over the spectrogram, from the start: before the player is made there are
  // WaveSurfer's scripts and up to three requests to wait for, and any of them
  // can take seconds. They are laid out for a timeline and a spectrogram, as
  // there nearly always are, and fitted to the plugins once those have loaded.
  const _waveH   = 128;
  let _timelineH = 20;
  let _spectroH  = 120;
  waveEl.style.position  = 'relative';
  waveEl.style.minHeight = `${_waveH + _timelineH + _spectroH}px`;
  // Waveform spinner covers the waveform + timeline zone.
  const spinner = _makeSpinner(0, _waveH + _timelineH);
  // Spectrogram spinner covers the spectrogram zone below.
  const spectroSpinner = _makeSpinner(_waveH + _timelineH, _spectroH);
  waveEl.prepend(spectroSpinner, spinner);

  // WaveSurfer + plugins are lazy-loaded on the first detail-page view.
  // While they're loading, kick the sample-rate Range request off in parallel
  // so both arrive together. If the loader fails (offline / the CDN blocked),
  // fall back to the plain <audio> player.
  const sampleRatePromise = _readFileSampleRate(url);
  // The recording's precomputed peaks (the API's peaks_url), fetched now so the
  // preview is ready as soon as there is somewhere to draw it. A recording
  // without peaks makes no request.
  const peaksPromise = hints.peaksUrl ? _fetchPeaks(hints.peaksUrl) : null;
  // And its precomputed spectrogram tiles' manifest, so that the spectrogram
  // can be shown from them as soon as the player is made.
  const tilesPromise = _fetchTilesManifest(hints.spectrogramUrl);
  try {
    await _loadWaveSurfer();
  } catch (_) {
    if (waveEl.isConnected) _initFallback(waveEl, btnEl, timeEl, url);
    return;
  }
  if (!waveEl.isConnected) return; // user navigated away during the load

  const ctrl = new AbortController();

  // Wait for the sample-rate Range request that we kicked off in parallel
  // with the WaveSurfer loader, so we can decode at the file's own rate. The
  // API's sample_rate covers files whose header we can't parse.
  const fileSampleRate = await sampleRatePromise;
  if (!waveEl.isConnected) return; // user navigated away during the fetch
  const decodeRate = _pickDecodeRate(fileSampleRate || hints.sampleRate, hints.duration, hints.channels);

  // Precomputed tiles are the spectrogram where they show more of it than the
  // browser can decode (a long recording decoded at a lower rate to save
  // memory, or one recorded above 96 kHz), and a preview of the in-browser one
  // otherwise. Without tiles, or the plugin, the in-browser one is all there is.
  const tilesFound  = await tilesPromise;
  if (!waveEl.isConnected) return;
  const TilesPlugin = tilesFound ? _getWsPlugin('TiledSpectrogram') : null;
  // Checked as the plugin will check it, so that a manifest it would refuse
  // leaves the in-browser spectrogram to do on its own, rather than nothing
  let tilesManifest = null;
  if (TilesPlugin) {
    try { tilesManifest = TilesPlugin.normaliseManifest(tilesFound.manifest); } catch (_) {}
  }
  const tilesOnly   = !!tilesManifest && tilesManifest.frequencyMax > decodeRate / 2 + 1;
  // A recording of several channels whose tiles have a view of each channel
  // as well as of their mix (manifest version 1.1) shows each channel one
  // above another, or the mix, or the channel chosen (see _channelChoices).
  // The tiles are then the spectrogram throughout, as the in-browser one shows
  // only the first channel.
  const viewOf = new Map();
  if (tilesManifest?.views?.[0]?.channels.length > 1 && typeof TilesPlugin.channelViews === 'function') {
    for (const index of TilesPlugin.channelViews(tilesManifest)) viewOf.set(tilesManifest.views[index].channels[0], index);
  }
  const channels = [...viewOf.keys()];
  let multi = channels.length > 1;
  // Where the tiles are the spectrogram nothing needs the decoded audio: the
  // waveform is drawn from the precomputed peaks, and the audio streams as it
  // plays instead of downloading whole first. That is what lets a recording too
  // long to decode in the browser (e.g. #10954, 30 min) play at all. The API's
  // peaks are used where there are some, and otherwise those the manifest lists
  // beside the tiles, chosen for the scale the waveform is drawn at. A
  // recording of several channels has the mix's and each channel's from the
  // manifest, or else the mix's alone, as one of a single channel has.
  let streamPeaks = null;
  if (tilesOnly && multi) {
    streamPeaks = await _fetchViewPeaks(TilesPlugin, tilesManifest, tilesFound.url, [0, ...channels.map(c => viewOf.get(c))]);
    if (!streamPeaks) multi = false;
  }
  if (tilesOnly && !streamPeaks) streamPeaks = await peaksPromise;
  if (tilesOnly && !streamPeaks) {
    const entry = TilesPlugin.choosePeaks(tilesManifest, WS_MIN_PX_PER_SEC);
    if (entry) streamPeaks = await _fetchPeaks(TilesPlugin.peaksUrl(entry, tilesFound.url));
  }
  if (!waveEl.isConnected) return;

  // RegionsPlugin
  const RegPlugin = _getWsPlugin('Regions');
  if (RegPlugin) {
    try { _wsRegions = RegPlugin.create(); } catch (_) { _wsRegions = null; }
  }

  // TimelinePlugin — NO separate container: must live inside WaveSurfer's own scroll
  // wrapper so the time labels scroll in sync with the expanded waveform.
  const TlPlugin = _getWsPlugin('Timeline');
  if (TlPlugin) {
    try {
      _wsTimeline = TlPlugin.create({
        height: 20,
        style: {
          fontFamily: "'Cascadia Code','Fira Code','SF Mono',Consolas,monospace",
          fontSize:   '10px',
          color:      '#8a9099',
        },
      });
    } catch (_) { _wsTimeline = null; }
  }

  // SpectrogramPlugin — NO separate container: must live inside WaveSurfer's scroll
  // wrapper so the full-resolution spectrogram scrolls in sync with the waveform.
  const SpecPlugin = (tilesOnly || multi) ? null : _getWsPlugin('Spectrogram');
  if (SpecPlugin) {
    try {
      _wsSpectrogram = SpecPlugin.create({
        labels:       false,        // we draw our own axis in the light DOM
        height:       120,
        fftSamples:   512,
        scale:        'linear',     // the plugin defaults to 'mel'; linear matches our axis labels
        colorMap:     'gray',
        gainDB:       50,           // shift so -50 dB signals show as mid-grey
        rangeDB:      80,
        useWebWorker: true,         // FFTs off the main thread; needs worker-src blob: in the CSP
        rendering:    'windowed',   // only what is on screen is computed, so zooming in stays cheap
      });
    } catch (_) { _wsSpectrogram = null; }
  }

  // TiledSpectrogram plugin — given the manifest fetched above, rather than its
  // address, so that it has nothing more to wait for. Where the recording has
  // several channels it starts split, a row for each channel, as the picker does.
  if (tilesManifest) {
    try {
      _wsTiles = TilesPlugin.create({ manifest: tilesManifest, baseUrl: tilesFound.url, height: 120, split: multi });
    } catch (_) { _wsTiles = null; }
  }
  // What a recording of several channels can show, starting as each channel's
  // waveform and spectrogram, one above another
  const choices = (multi && _wsTiles)
    ? _channelChoices(channels, viewOf, !!streamPeaks, tilesManifest.channelCount)
    : null;

  // Annotations plugin — it draws boxes on the tiles until they hand over, then
  // on the in-browser spectrogram, and the axis below is drawn from the view it
  // reports, so that the two always agree. Its views are given to it rather than
  // found: it looks for the in-browser spectrogram's element as soon as that says
  // it is ready, but the element gets its canvas a moment later, so the look
  // failed with a warning, and the tiles' view (or none) was used until the next
  // layout. The plugin draws on one spectrogram, so each row of tiles split by
  // channel has an instance of it for its boxes: the first with the regions, and
  // the rest without. Each is given the tiles too, so that it is laid out when
  // they load. Where a row is on the player, or null where it is not shown (or
  // not yet).
  const rowView = row => () => {
    const tilesEl = _ws?.getWrapper()?.querySelector('[part~="tiled-spectrogram"]');
    const rows = _wsTiles?.getShownViews().length || 0;   // none until the manifest has loaded
    if (!tilesEl || row >= rows) return null;
    return {
      min: 0, max: tilesManifest.frequencyMax, scale: 'linear',
      top: tilesEl.offsetTop + row * _spectroH, height: _spectroH,
    };
  };
  // Once the in-browser spectrogram is ready it is drawn over the tiles (see
  // handOver), and is then the spectrogram: 0 Hz to the Nyquist of the decoded
  // audio, as its axis is labelled when there is no Annotations plugin.
  let spectroDrawn = false;
  const specView = () => ({
    min: 0, max: (_ws?.getDecodedData?.()?.sampleRate || decodeRate) / 2, scale: 'linear',
    top: _waveH + _timelineH, height: _spectroH,
  });
  const shownView = () => spectroDrawn ? specView() : rowView(0)();
  const AnnPlugin = _wsRegions ? _getWsPlugin('Annotations') : null;
  if (AnnPlugin) {
    try {
      // From wavesurfer-annotations 0.2.0 an instance draws the regions of one row
      // of a split waveform, its `row` option. An earlier build has no such option,
      // and draws each instance's regions across the whole waveform, so there the
      // rows after the first take no regions of their own.
      const rowRegions = AnnPlugin.create({}).options.row !== undefined;
      _wsAnnotations = AnnPlugin.create({
        regions:       _wsRegions,
        spectrogram:   choices ? _wsTiles : [_wsTiles, _wsSpectrogram].filter(Boolean),
        frequencyView: shownView,
        row:           choices ? 0 : -1,
        fillOpacity:   _BOX_FILL_OPACITY,
      });
      _wsRowAnnotations = [];
      if (choices) {
        for (let row = 1; row < channels.length; row++) {
          _wsRowAnnotations.push(AnnPlugin.create(rowRegions
            ? { regions: _wsRegions, spectrogram: _wsTiles, frequencyView: rowView(row), row: row, fillOpacity: _BOX_FILL_OPACITY }
            : { spectrogram: _wsTiles, frequencyView: rowView(row), fillOpacity: _BOX_FILL_OPACITY }));
        }
      }
    } catch (_) { _wsAnnotations = null; _wsRowAnnotations = []; }
  }

  // The player's height and its spinners, fitted to the plugins there are
  _timelineH = _wsTimeline ? 20 : 0;
  _spectroH  = (_wsSpectrogram || _wsTiles) ? 120 : 0;
  waveEl.style.minHeight   = `${_waveH + _timelineH + _spectroH}px`;
  spinner.style.height     = `${_waveH + _timelineH}px`;
  spectroSpinner.style.top = `${_waveH + _timelineH}px`;
  if (!_spectroH) spectroSpinner.remove();

  // The freq-axis canvas is already in the HTML template (ws-freq-<id>),
  // to the left of waveEl inside .ws-player-row (a flex container).
  // Just look it up — no dynamic DOM surgery needed.
  const _freqCanvas = _spectroH
    ? document.getElementById(waveEl.id.replace('ws-wave-', 'ws-freq-'))
    : null;

  // The axis is drawn from what the Annotations plugin says is on screen, so
  // that it and the boxes always agree, through a hand-over too. It says so as
  // soon as the tiles do, before any audio has arrived. (Both spectrograms
  // here start at 0 Hz.) That is the view of one row, so the axis is drawn for
  // each row the tiles show, and again when the tiles load or change view.
  const axisRows = () => _wsTiles?.getShownViews().length || 1;
  let axisView = null;
  const drawAxis = () => {
    if (axisView && _freqCanvas) _drawFreqAxis(_freqCanvas, axisView.height, axisView.max, axisView.top, axisRows());
  };
  _wsAnnotations?.on('view', view => { axisView = view; drawAxis(); });
  _wsTiles?.on('view', drawAxis);
  _wsTiles?.on('load', m => {
    // Without that plugin: the tiles say what frequencies they show as soon as
    // WaveSurfer has been made with them, so the axis is drawn from them first.
    if (!_wsAnnotations) axisView = { height: _spectroH, max: m.frequencyMax, top: _waveH + _timelineH };
    drawAxis();
  });

  // WaveSurfer gives its element the recording only once the whole file has
  // downloaded, to decode it. Play pressed before then gives the element the
  // recording's URL instead, and it streams from there; WaveSurfer keeps that
  // source (see setSrc), so the playing carries on while it downloads the file.
  _releaseAudio(_wsAudio);
  const audio = new Audio();
  _wsAudio = audio;
  const ws = WaveSurfer.create({
    container:     waveEl,
    waveColor:     '#000',
    progressColor: 'rgba(82,183,136,0.85)',
    cursorColor:   '#52b788',
    height:        WS_WAVE_H,
    splitChannels: choices?.split('split'),
    minPxPerSec:   WS_MIN_PX_PER_SEC,
    normalize:     true,
    sampleRate:    decodeRate,
    media:         audio,
    plugins: [
      ...(_wsRegions     ? [_wsRegions]     : []),
      ...(_wsTimeline    ? [_wsTimeline]    : []),
      // The tiles sit just above the in-browser spectrogram, which takes their
      // place when it is drawn (see handOver below)
      ...(_wsTiles       ? [_wsTiles]       : []),
      ...(_wsSpectrogram ? [_wsSpectrogram] : []),
      ...(_wsAnnotations ? [_wsAnnotations] : []),
      ..._wsRowAnnotations,
    ],
  });

  const loadBar = document.createElement('div');
  Object.assign(loadBar.style, {
    position:     'absolute',
    top:          '0',
    left:         '0',
    height:       '3px',
    width:        '0%',
    background:   'rgba(82,183,136,0.85)',
    transition:   'width 0.15s ease',
    zIndex:       '10',
    borderRadius: '0 2px 2px 0',
  });

  waveEl.insertBefore(loadBar, waveEl.firstChild);

  ws.on('loading', pct => {
    loadBar.style.width = pct + '%';
  });

  // Always handle errors — fall back to plain audio.
  ws.on('error', () => {
    loadBar.remove();
    spinner.remove();
    spectroSpinner.remove();
    ctrl.abort();
    _releaseAudio(audio);
    _ws = null;
    _wsRegions     = null;
    _wsTimeline    = null;
    _wsSpectrogram = null;
    _wsTiles       = null;
    _wsAnnotations = null;
    _wsRowAnnotations = [];
    try { ws.destroy(); } catch (_) {}
    if (waveEl.isConnected) _initFallback(waveEl, btnEl, timeEl, url);
  });

  // A recording of several channels draws its waveform from each channel's
  // peaks first, so that the progress shows at once. Once the audio is decoded,
  // the waveform is drawn again from it: WaveSurfer takes decoded channel data
  // as it takes peaks. Its spectrogram is the tiles, so nothing else waits.
  let firstPeaks = null;
  if (choices && !streamPeaks) {
    firstPeaks = await _fetchViewPeaks(TilesPlugin, tilesManifest, tilesFound.url, channels.map(c => viewOf.get(c)));
    if (!waveEl.isConnected) return;
  }
  // Streamed with the manifest's duration, which is exact: a peaks file's is
  // rounded up to its last point, and the tiles are laid out by the manifest's
  if (streamPeaks) ws.load(url, streamPeaks.channels, tilesManifest.duration);
  else if (firstPeaks) {
    const off = ws.on('ready', async () => {
      off();
      try {
        const ctx = new AudioContext({ sampleRate: decodeRate });
        const buf = await ctx.decodeAudioData(await fetch(url).then(r => r.arrayBuffer()));
        ctx.close();
        if (!waveEl.isConnected) return;
        ws.load(url, Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), buf.duration);
      } catch (e) {
        console.warn('Waveform not redrawn from the audio', e);
      }
    });
    ws.load(url, firstPeaks.channels, firstPeaks.duration);
  } else ws.load(url);
  _ws = ws;

  // Draw the precomputed peaks as a preview canvas while WaveSurfer decodes
  // the audio. The preview is removed once WaveSurfer renders. A recording of
  // several channels is previewed from each channel's peaks in the tiles, as
  // the API's peaks file for it has one channel; any other from the API's.
  let _peaksPreview = null;
  if (!streamPeaks) {
    const channelPeaks = choices
      ? _fetchViewPeaks(TilesPlugin, tilesManifest, tilesFound.url, channels.map(c => viewOf.get(c)))
      : null;
    Promise.resolve(channelPeaks).then(result => result || peaksPromise).then(result => {
      if (result && !_wsReady && waveEl.isConnected) {
        _peaksPreview = _drawPeaksPreview(waveEl, result.channels, result.duration, !!choices);
      }
    });
  }

  function updateTime() {
    if (!timeEl) return;
    const cur = ws.getCurrentTime ? ws.getCurrentTime() : 0;
    const dur = ws.getDuration    ? ws.getDuration()    : 0;
    timeEl.textContent = dur ? `${_fmt(cur)} / ${_fmt(dur)}` : _fmt(cur);
  }

  btnEl?.addEventListener('click', () => {
    // Until WaveSurfer has given the element the recording, play streams it
    if (!audio.src) audio.src = url;
    ws.playPause();
  }, { signal: ctrl.signal });
  // Where the tiles are the spectrogram, nothing is finer than their finest
  // level and the peaks, so zooming in stops at four pixels a column of it
  _setupZoom(ws, waveEl, ctrl.signal, tilesOnly
    ? Math.max(WS_MIN_PX_PER_SEC, 4 * tilesManifest.levels[0].columnsPerSecond)
    : WS_MAX_PX_PER_SEC, _wsSpectrogram);
  if (choices) _setupChannels(ws, waveEl, ctrl.signal, _wsTiles, channels, choices);

  ws.on('play', () => {
    if (btnEl) { btnEl.innerHTML = ICON_PAUSE; btnEl.classList.add('playing'); }
    document.getElementById('global-audio')?.pause();
    window.dispatchEvent(new Event('corpus:waveplay'));
  });
  ws.on('pause',  () => { if (btnEl) { btnEl.innerHTML = ICON_PLAY; btnEl.classList.remove('playing'); } });
  ws.on('finish', () => { if (btnEl) { btnEl.innerHTML = ICON_PLAY; btnEl.classList.remove('playing'); } });
  if (_wsSpectrogram) {
    _wsSpectrogram.on('ready', () => {
      spectroSpinner.remove();
      spectroDrawn = true;
      // The plugin draws 0 Hz up to the Nyquist of the decoded audio, so label
      // exactly that range (the Annotations plugin says the same, where it is)
      if (_freqCanvas && !_wsAnnotations) _drawFreqAxis(_freqCanvas, _spectroH, (ws.getDecodedData?.()?.sampleRate || decodeRate) / 2, _waveH + _timelineH);
    });
  }
  // The tiles are shown at once. Where the in-browser spectrogram shows as much
  // as they do, it takes their place when it is drawn; otherwise they stay.
  if (_wsTiles) {
    _wsTiles.on('ready', () => spectroSpinner.remove());
    if (_wsSpectrogram) _wsTiles.handOver(_wsSpectrogram);
  }

  ws.on('ready', () => {
    loadBar.remove();
    spinner.remove();
    _peaksPreview?.remove();
    _wsReady = true;
    if (_pendingSeek != null) { ws.setTime(_pendingSeek); _pendingSeek = null; }
    updateTime();
    _reapplyVisibleRegions();
  });
  ws.on('decode',       updateTime);
  ws.on('audioprocess', updateTime);
  ws.on('timeupdate',   updateTime);

  _registerCardPlayHandler(() => ws.pause());
}

// Stop an element that played a recording, and let go of the recording
function _releaseAudio(audio) {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

/**
 * Destroy the WaveSurfer detail player, and forget the annotation and BirdNET
 * rows it was showing. Call when navigating away; renderDetail calls it too,
 * before it shows the next recording.
 */
export function destroyDetailPlayer() {
  if (_wsCardPlayHandler) {
    window.removeEventListener('corpus:cardplay', _wsCardPlayHandler);
    _wsCardPlayHandler = null;
  }
  if (_ws) { try { _ws.destroy(); } catch (_) {} _ws = null; }
  _releaseAudio(_wsAudio);
  _wsAudio = null;
  if (_fallbackAudio) { _fallbackAudio.pause(); _fallbackAudio = null; }
  _wsReady            = false;
  _wsRegions          = null;
  _wsTimeline         = null;
  _wsSpectrogram      = null;
  _wsTiles            = null;
  _wsAnnotations      = null;
  _wsRowAnnotations   = [];
  _cachedAnnotations  = null;
  _cachedBirdNet      = null;
  _wsRegionsList      = [];
  _pendingSeek        = null;
  _annotationsVisible = true;
  _birdnetVisible     = true;
}

/**
 * Render a list of recording objects into a container element.
 * @param {object[]}    recordings
 * @param {HTMLElement} container
 * @param {Function}    onDetail   - called with the recording object when a card is clicked
 */
export function renderRecordings(recordings, container, onDetail) {
  if (!recordings || recordings.length === 0) {
    showEmpty(container, 'No recordings found.');
    return;
  }

  const html = recordings.map(r => recordingCard(r)).join('');
  container.innerHTML = `<div class="results-grid">${html}</div>`;

  container.querySelectorAll('.recording-card').forEach((card, i) => {
    card.addEventListener('click', () => onDetail && onDetail(recordings[i]));
  });

  container.querySelectorAll('.play-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      togglePlay(btn.dataset.url, btn.dataset.id);
    });
  });

  // Anchors inside the card need to stop propagation so the whole-card click
  // (which opens the detail view) doesn't also fire when a user clicks a link.
  container.querySelectorAll('[data-stop-propagation]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });

  // The title links to the recording's page. A plain click on it is the card's
  // click, which opens the recording here; a modified click (new tab or window)
  // goes to the browser, and the card does not also open the recording.
  container.querySelectorAll('.card-title a').forEach(a => {
    a.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) e.stopPropagation();
      else e.preventDefault();
    });
  });
}

/**
 * Render the full detail view for one recording.
 * @param {object}      recording
 * @param {HTMLElement} container
 * @param {Function}    onTaxonSearch - called with taxon name when a taxonomy link is clicked
 */
const TAXON_FIELDS = new Set([
  'taxon', 'kingdom', 'class', 'order', 'family', 'genus', 'species',
  'rank', 'tribe', 'subfamily', 'suborder', 'phylum',
]);
const SKIP_FIELDS = new Set([
  'id', 'filename', 'name', 'source', 'taxon_id', ...TAXON_FIELDS,
]);

function formatKey(k) {
  if (k === 'author') return 'Uploaded by';
  return k
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function _issueUrl(repo, title, recordingUrl) {
  const body = recordingUrl
    ? `Please describe the issue\n\n\nIssue on page ${recordingUrl}`
    : 'Please describe the issue';
  return `https://github.com/${repo}/issues/new?labels=data-quality-issue`
       + `&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export function renderDetail(recording, container, onTaxonSearch) {
  // Going from one recording to another stays on the detail page, so the
  // router doesn't destroy the player then. Do it here: otherwise the previous
  // recording's annotation and BirdNET rows are drawn as regions on the new
  // player's waveform when it is ready, and the toggles keep their old state
  // while the checkboxes below start from their defaults.
  destroyDetailPlayer();

  const r = recording;
  const hasId   = r.id != null;
  const id      = hasId ? r.id : '?';
  const title   = r.name || r.taxon || 'Untitled recording';
  const taxon   = r.taxon   || '';
  const source  = r.source  || config.source;
  const fileUrl = hasId ? config.resolveFileUrl(r.filename) : '';

  // Render every field the API returned, in arrival order.
  const metaRows = Object.entries(r)
    .filter(([k, v]) => !SKIP_FIELDS.has(k) && v != null && v !== '')
    .map(([k, v]) => `<tr><td>${esc(formatKey(k))}</td><td>${esc(String(v))}</td></tr>`)
    .join('');

  // wsId is embedded in element IDs and used as a querySelector fragment, so
  // it must be a valid CSS ident. Restrict to [A-Za-z0-9_-]; fall back to
  // a generated token if the API somehow returns something exotic.
  const wsId = /^[A-Za-z0-9_-]+$/.test(String(id))
    ? String(id)
    : ('x' + Math.random().toString(36).slice(2, 10));

  const safeFileUrl = safeUrl(fileUrl);
  const idStr = esc(String(id));
  const srcStr = esc(source);
  const issueHref = config.githubRepo
    ? safeUrl(_issueUrl(config.githubRepo, title, config.recordingPageUrl(id)))
    : '';

  container.innerHTML = `
    <h1 class="detail-title">${esc(title)}</h1>
    ${taxon && taxon !== title ? `<div class="detail-title" style="font-size:1.1rem;margin-bottom:0.25rem">${esc(subgenusBrackets(taxon))}</div>` : ''}
    <div class="detail-meta">#${idStr} · ${srcStr}</div>

    ${safeFileUrl ? `
    <div class="audio-player wavesurfer-player">
      <div class="ws-player-row">
        <canvas class="ws-freq-axis" id="ws-freq-${wsId}"></canvas>
        <div class="ws-waveform" id="ws-wave-${wsId}"></div>
      </div>
      <div class="ws-controls">
        <button class="ws-play" id="ws-play-${wsId}" title="Play / Pause"
                aria-label="Play or pause recording">
          ${ICON_PLAY}
        </button>
        <span class="ws-time" id="ws-time-${wsId}">0:00 / 0:00</span>
        <span class="ws-zoom" id="ws-zoom-${wsId}" hidden>
          <button type="button" class="ws-zoom-btn" data-zoom="out" title="Zoom out (or Ctrl + scroll)" aria-label="Zoom out">−</button>
          <button type="button" class="ws-zoom-btn" data-zoom="fit" title="Show the whole recording" aria-label="Show the whole recording">↔</button>
          <button type="button" class="ws-zoom-btn" data-zoom="in" title="Zoom in (or Ctrl + scroll)" aria-label="Zoom in">+</button>
        </span>
        <span class="ws-channels" id="ws-channels-${wsId}" hidden>
          <select class="ws-channels-select" title="Each channel's waveform over the channels' spectrogram, or one waveform and spectrogram: of the channels together, or of one"
                  aria-label="Channels shown"></select>
        </span>
        <label class="ws-ann-toggle" style="display:none" title="Show / hide annotations"><input type="checkbox" class="ws-ann-check" checked> Annotations</label>
        <label class="ws-birdnet-toggle" style="display:none" title="Show / hide BirdNET identifications"><input type="checkbox" class="ws-birdnet-check" checked> BirdNET</label>
        <a href="${esc(safeFileUrl)}" target="_blank" rel="noopener"
           class="btn btn-ghost ws-dl" data-stop-propagation>↓ Download</a>
      </div>
    </div>` : ''}

    <div class="detail-actions">
      <a href="https://view.audioblast.org/?source=${srcStr}&amp;id=${idStr}"
         target="_blank" rel="noopener" class="detail-action-link">🔍 Analyses on audioBlast</a>
      <a href="https://api.audioblast.org/embed/?source=${srcStr}&amp;id=${idStr}"
         target="_blank" rel="noopener" class="detail-action-link">⊞ Embed with audioBlast</a>
      ${issueHref ? `<a href="${esc(issueHref)}"
         target="_blank" rel="noopener" class="detail-action-link">⚑ Report data quality issue on this page via GitHub</a>` : ''}
    </div>

    <div class="detail-grid">
      <div class="detail-main">
        <div id="detail-annotations-block"></div>
        <div id="detail-birdnet-block"></div>
        <h3 class="detail-section-heading">Metadata</h3>
        <table class="meta-table">${metaRows}</table>
      </div>

      <div class="detail-side">
        <div class="sidebar-card" id="taxonomy-block">
          <div class="sidebar-title">Taxonomy</div>
          <div class="taxon-breadcrumb" id="taxon-links">
            <div class="loading" style="padding:0.5rem 0;font-size:12px">
              <div class="spinner"></div>Loading…
            </div>
          </div>
        </div>
      </div>
    </div>`;

  if (safeFileUrl) {
    _initWaveSurfer(
      container.querySelector(`#ws-wave-${wsId}`),
      container.querySelector(`#ws-play-${wsId}`),
      container.querySelector(`#ws-time-${wsId}`),
      safeFileUrl,
      // API metadata: a fallback sample rate, the size for the decode budget,
      // and the precomputed peaks the preview is drawn from, where there are any.
      { sampleRate: Number(r.sample_rate), duration: Number(r.duration), channels: Number(r.channels),
        peaksUrl: safeUrl(r.peaks_url),
        spectrogramUrl: safeUrl(r.spectrogram_url) },
    );
  }

  // Wire CSP-safe stop-propagation on links the inline onclick used to handle.
  container.querySelectorAll('[data-stop-propagation]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });

  const annCheck = container.querySelector('.ws-ann-check');
  if (annCheck) {
    annCheck.addEventListener('change', () => _toggleAnnotations(container, annCheck.checked));
  }

  const birdnetCheck = container.querySelector('.ws-birdnet-check');
  if (birdnetCheck) {
    birdnetCheck.addEventListener('change', () => _toggleBirdNet(container, birdnetCheck.checked));
  }

  if (onTaxonSearch) {
    container.querySelectorAll('.taxon-name[data-taxon]').forEach(el => {
      el.addEventListener('click', () => onTaxonSearch(el.dataset.taxon));
    });
  }
}

/**
 * Update the taxonomy sidebar block after the main detail view is rendered.
 * Call this once fetchRecordingTaxa() resolves.
 * @param {HTMLElement} container  the same container passed to renderDetail
 * @param {object|null} taxa       row from /data/taxa/ merged onto the
 *                                  recording, or null on failure
 * @param {Function}    onTaxonSearch
 */
export function renderTaxonomy(container, taxa, onTaxonSearch) {
  const block = container.querySelector('#taxon-links');
  if (!block) return;

  if (!taxa) {
    block.innerHTML = '<span style="font-size:12px;color:var(--text3)">Not available</span>';
    return;
  }

  const html = buildTaxonHierarchy(taxa, onTaxonSearch);
  block.innerHTML = html || '<span style="font-size:12px;color:var(--text3)">Not available</span>';

  const taxonHref = html ? staticPageHref('t', taxa.taxon_id, taxa.recording_type) : '';
  if (taxonHref) {
    block.insertAdjacentHTML('beforeend',
      `<div class="taxon-step"><a href="${esc(taxonHref)}">Page for this taxon</a></div>`);
  }

  if (onTaxonSearch) {
    block.querySelectorAll('.taxon-name[data-taxon]').forEach(el => {
      el.addEventListener('click', () => onTaxonSearch(el.dataset.taxon));
    });
  }
}

// ── Internal ──────────────────────────────────────────────────────

function recordingCard(r) {
  const id      = r.id;
  const title   = r.name || r.taxon || 'Untitled recording';
  const taxon   = r.taxon || '';
  const fileUrl = safeUrl(config.resolveFileUrl(r.filename));
  const date    = r.date          || '';
  const author  = r.author        || '';
  const type    = r.recording_type || '';
  // Older joined rows used capitalised rank fields; /data/taxa/
  // returns lowercase — accept either via getField().
  const order   = getField(r, 'Order');
  const family  = getField(r, 'Family');
  const idStr   = esc(String(id));
  const pageHref = staticPageHref('r', id, type);

  return `
  <div class="recording-card" data-id="${idStr}">
    <button class="play-btn" id="play-${idStr}"
            data-url="${esc(fileUrl)}" data-id="${idStr}"
            title="Play / pause" aria-label="Play or pause recording">
      <svg viewBox="0 0 10 12"><polygon points="0,0 10,6 0,12"/></svg>
    </button>

    <div class="card-body">
      <div class="card-title">${pageHref ? `<a href="${esc(pageHref)}">${esc(title)}</a>` : esc(title)}</div>
      <div class="card-meta">
        ${date   ? `<span>📅 ${esc(date)}</span>`   : ''}
        ${author ? `<span>🎙 Uploaded by: ${esc(author)}</span>` : ''}
        <span style="color:var(--text3);font-size:10px">#${idStr}</span>
      </div>
      <div class="card-tags">
        ${type                  ? `<span class="tag type">${esc(type)}</span>`   : ''}
        ${order                 ? `<span class="tag">${esc(order)}</span>`       : ''}
        ${family                ? `<span class="tag">${esc(family)}</span>`      : ''}
        ${taxon !== UNKNOWN_TAXON ? `<span class="tag taxon${ITALIC_RANKS.has((r.Rank || r.rank || '').toLowerCase()) ? ' taxon--italic' : ''}">${esc(subgenusBrackets(taxon))}</span>` : ''}
      </div>
    </div>

    <div class="card-actions">
      ${fileUrl
        ? `<a class="icon-btn" href="${esc(fileUrl)}" target="_blank" rel="noopener"
              title="Download" aria-label="Download recording" data-stop-propagation>↓</a>`
        : ''}
    </div>
  </div>`;
}

/**
 * Fill the traits sidebar block after the main detail view is rendered.
 * Call this once fetchTraits() resolves.
 * @param {HTMLElement} container  the same container passed to renderDetail
 * @param {object[]|null} traitData  rows from /data/traits/, or null on failure
 */
export function renderTraits(container, traitData) {
  const block = container.querySelector('#traits-content');
  if (!block) return;

  if (!traitData || traitData.length === 0) {
    block.innerHTML = '<span style="font-size:12px;color:var(--text3)">No traits available</span>';
    return;
  }

  // Group rows by call_type + sex combination.
  const groups = new Map();
  for (const t of traitData) {
    const key = `${t.call_type || ''}|${t.sex || ''}`;
    if (!groups.has(key)) groups.set(key, { call_type: t.call_type, sex: t.sex, rows: [] });
    groups.get(key).rows.push(t);
  }

  let html = '';
  for (const { call_type, sex, rows } of groups.values()) {
    const label = [call_type, sex].filter(Boolean).join(' · ');
    if (label) html += `<div class="traits-group-label">${esc(label)}</div>`;
    html += '<table class="traits-table">';
    for (const t of rows) {
      const ontHref = safeUrl(t.trait_ontology);
      const nameCell = ontHref
        ? `<a href="${esc(ontHref)}" target="_blank" rel="noopener" class="trait-link">${esc(t.trait)}</a>`
        : esc(t.trait);
      const range = (t.value_min != null || t.value_max != null)
        ? ` (${t.value_min ?? ''}–${t.value_max ?? ''})`
        : '';
      const temp = t.temperature
        ? ` <span class="traits-temp">${esc(String(t.temperature))}°C</span>`
        : '';
      const valueCell = t.value != null ? esc(String(t.value)) : '—';
      html += `<tr>
        <td class="trait-name">${nameCell}</td>
        <td class="trait-val">${valueCell}${range}${temp}</td>
      </tr>`;
    }
    html += '</table>';
  }

  block.innerHTML = html;
}

/**
 * Fill the annotations tab panel after the main taxon view is rendered.
 * Call this once fetchAnnotationsForTaxon() resolves.
 * @param {HTMLElement} container  the container passed to _renderTaxonShell
 * @param {object[]|null} annotationData  rows from /data/annomate/, or null
 */
export function annotationRecordingId(a) {
  const id = a.source_id;
  if (id == null || id === '') return null;
  // A corpus can mark another source's recordings, which this site doesn't show
  if (a.recording_source && a.recording_source !== config.source) return null;
  return String(id);
}

// The annotation's time as a link to its recording, as plain text where the
// recording isn't one of this site's. `data-recording` is picked up by the
// click handler the caller adds.
export function annotationRecordingLink(a, label) {
  const id = annotationRecordingId(a);
  if (!id) return esc(label);
  // The recording opens at the annotation's start, when it has one
  const start = parseFloat(a.time_start);
  const t = isFinite(start) && start > 0 ? String(start) : '';
  const href = `?id=${encodeURIComponent(id)}${t ? `&t=${encodeURIComponent(t)}` : ''}`;
  return `<a href="${href}" class="trait-link" data-recording="${esc(id)}"${t ? ` data-t="${esc(t)}"` : ''}>${esc(label)}</a>`;
}

// Seek the detail player to `t` seconds: at once if the recording is loaded,
// else as soon as it is. Call after renderDetail, which clears any earlier one.
export function seekDetailTo(t) {
  t = parseFloat(t);
  if (!isFinite(t) || t < 0) return;
  if (_ws && _wsReady) _ws.setTime(t);
  else _pendingSeek = t;
}

export function renderAnnotations(container, annotationData, onRecording) {
  const block = container.querySelector('#annotations-content');
  if (!block) return;

  if (!annotationData || annotationData.length === 0) {
    block.innerHTML = '<span style="font-size:12px;color:var(--text3)">No annotations available</span>';
    return;
  }

  const groups = new Map();
  for (const a of annotationData) {
    const key = a.type || '(untyped)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  let html = '';
  for (const [type, rows] of groups.entries()) {
    html += `<div class="traits-group-label">${esc(type)}</div>`;
    html += '<table class="traits-table">';
    for (const a of rows) {
      const timeRange = formatTimeRange(a.time_start, a.time_end);
      const annotatorText = esc(a.annotator || '—');
      // A relative info URL (the source gives just "view") goes nowhere here
      const infoHref = /^https?:/i.test(a.annotation_info_url || '') ? safeUrl(a.annotation_info_url) : '';
      const annotatorCell = infoHref
        ? `<a href="${esc(infoHref)}" target="_blank" rel="noopener" class="trait-link">${annotatorText}</a>`
        : annotationRecordingLink(a, a.annotator || '—');
      html += `<tr>
        <td class="trait-name">${annotatorCell}</td>
        <td class="trait-val">${annotationRecordingLink(a, timeRange ? timeRange + 's' : 'Recording')}</td>
      </tr>`;
    }
    html += '</table>';
  }

  block.innerHTML = html;
  if (onRecording) wireRecordingLinks(block, onRecording);
}

// Open the recording in the page on a plain click, leaving a modified click
// (new tab, new window) to the link itself.
export function wireRecordingLinks(root, onRecording) {
  root.querySelectorAll('a[data-recording]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onRecording({ id: el.dataset.recording, t: el.dataset.t });
    });
  });
}

export function getField(r, key) {
  return r[key] ?? r[key.toLowerCase()] ?? r[key[0].toUpperCase() + key.slice(1).toLowerCase()] ?? '';
}

function buildTaxonHierarchy(r, onTaxonSearch) {
  const ranks = [
    ['Kingdom', getField(r, 'Kingdom')],
    ['Phylum',  getField(r, 'Phylum')],
    ['Class',   getField(r, 'Class')],
    ['Order',   getField(r, 'Order')],
    ['Family',  getField(r, 'Family')],
    ['Genus',   getField(r, 'Genus')],
    ['Species', getField(r, 'Species') || getField(r, 'taxon')],
  ].filter(([, v]) => v);

  if (!ranks.length) return '';

  return ranks.map(([rank, name]) => {
    const italic = ITALIC_RANKS.has(rank.toLowerCase());
    const displayName = esc(subgenusBrackets(name));
    return `
    <div class="taxon-step">
      <span class="taxon-rank">${esc(rank)}</span>
      <span class="taxon-name${italic ? ' taxon-name--italic' : ''}" data-taxon="${esc(name)}">${displayName}</span>
    </div>`;
  }).join('');
}
