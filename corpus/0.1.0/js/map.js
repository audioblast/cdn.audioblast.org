/**
 * map.js — The recordings map: each recording placed where the specimen it is of
 * was collected, not where the recording was made. Drawn with Leaflet, from
 * js/vendor/. Leaflet loads the first time the map opens, as WaveSurfer does for
 * the player (render.js).
 */

import { fetchSpecimenMap } from './api.js';
import config from './config.js';
import { esc, showError } from './ui.js';
import { staticPageHref, subgenusBrackets, wireRecordingLinks, UNKNOWN_TAXON } from './render.js';

// ── Loading Leaflet ───────────────────────────────────────────────

const VENDOR = new URL('vendor/', import.meta.url).href;
const LEAFLET_CSS = [
  `${VENDOR}leaflet/leaflet.css`,
  `${VENDOR}leaflet.markercluster/MarkerCluster.css`,
  `${VENDOR}leaflet.markercluster/MarkerCluster.Default.css`,
];
const LEAFLET_JS = `${VENDOR}leaflet/leaflet.js`;
const CLUSTER_JS = `${VENDOR}leaflet.markercluster/leaflet.markercluster.js`;

// Add a stylesheet or script to the page; resolves once it has loaded.
function _addTag(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs);
    el.onload  = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${attrs.src || attrs.href}`));
    document.head.appendChild(el);
  });
}

let _leaflet = null;   // resolves to the Leaflet global, L, once the cluster plugin is in

function _loadLeaflet() {
  if (!_leaflet) {
    _leaflet = Promise.all(LEAFLET_CSS.map(href => _addTag('link', { rel: 'stylesheet', href })))
      .then(() => _addTag('script', { src: LEAFLET_JS }))
      .then(() => _addTag('script', { src: CLUSTER_JS }))
      .then(() => window.L)
      .catch(err => { _leaflet = null; throw err; });
  }
  return _leaflet;
}

// ── Text ──────────────────────────────────────────────────────────

// The count with its noun: "1 recording", "706 recordings".
function _plural(n, noun) {
  return `${n.toLocaleString()} ${n === 1 ? noun : `${noun}s`}`;
}

// The country's name for its ISO code, where the browser can give one.
const _regionNames = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function _countryName(code) {
  if (!code) return '';
  try { return _regionNames ? _regionNames.of(code) : code; }
  catch (_) { return code; }
}

function _placeTitle(place) {
  return `${_plural(place.recordings.length, 'recording')}, ${_countryName(place.country) || 'unknown country'}`;
}

// ── Popups ────────────────────────────────────────────────────────

// The popup for one place: where it is, the specimens collected there, and the
// recordings of them, each of which opens in the page.
function _popupElement(place, onRecording) {
  const el = document.createElement('div');
  el.className = 'map-popup';
  el.innerHTML = _popupHtml(place);
  wireRecordingLinks(el, onRecording);
  return el;
}

function _popupHtml(place) {
  const names = [...new Set(place.specimens.map(s => s.scientificName).filter(Boolean))];
  const items = place.recordings.map(r => {
    const href  = staticPageHref('r', r.id, r.recording_type) || `?id=${encodeURIComponent(r.id)}`;
    const label = r.name || r.taxon || 'Untitled recording';
    const taxon = r.taxon && r.taxon !== UNKNOWN_TAXON
      ? ` <span class="map-popup-taxon">${esc(subgenusBrackets(r.taxon))}</span>`
      : '';
    return `<li><a href="${esc(href)}" data-recording="${esc(r.id)}">${esc(label)}</a>${taxon}</li>`;
  }).join('');
  const specimens = names.length
    ? `<div class="map-popup-specimens">${names.length > 1 ? 'Specimens' : 'Specimen'}: ${names.map(n => `<em>${esc(n)}</em>`).join(', ')}</div>`
    : '';
  return `
    <div class="map-popup-place">${esc(_countryName(place.country) || 'Unknown country')}<span class="map-popup-coords">${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}</span></div>
    ${specimens}
    <ul class="map-popup-list">${items}</ul>`;
}

// ── The map ───────────────────────────────────────────────────────

let _map = null;       // the Leaflet map, made the first time the page opens
let _drawing = null;   // the promise of that first drawing, so the map is made once

/**
 * Show the recordings map in `view`. It is drawn the first time the page opens,
 * and each later time is only resized to the page.
 *
 * @param {{canvas: HTMLElement, count: HTMLElement, note: HTMLElement}} view
 * @param {({id: string, t?: string}) => void} onRecording  opens a recording in the page
 */
export function showSpecimenMap(view, onRecording) {
  if (_map) { _map.invalidateSize(); return; }
  if (!_drawing) {
    view.count.textContent = 'Loading the map…';
    _drawing = _draw(view, onRecording).catch(err => {
      _drawing = null;
      showError(view.count, `The map could not be drawn: ${err.message}`);
    });
  }
}

async function _draw(view, onRecording) {
  const [L, data] = await Promise.all([_loadLeaflet(), fetchSpecimenMap()]);

  _map = L.map(view.canvas, { worldCopyJump: true });
  L.tileLayer(config.mapTiles.url, {
    attribution: config.mapTiles.attribution,
    maxZoom: 18,
  }).addTo(_map);

  // A cluster counts the recordings under it, not the places, so its number
  // is on the same footing as the count above the map.
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 40,
    showCoverageOnHover: false,
    iconCreateFunction: group => {
      const n = group.getAllChildMarkers().reduce((sum, m) => sum + m.options.recordings, 0);
      const size = n < 10 ? 'small' : n < 100 ? 'medium' : 'large';
      return L.divIcon({
        html: `<div><span>${n.toLocaleString()}</span></div>`,
        className: `marker-cluster marker-cluster-${size}`,
        iconSize: L.point(40, 40),
      });
    },
  });
  const dot = L.divIcon({ className: 'map-dot', iconSize: [14, 14] });
  for (const place of data.points) {
    const marker = L.marker([place.lat, place.lon], {
      icon:       dot,
      title:      _placeTitle(place),
      recordings: place.recordings.length,
    });
    marker.bindPopup(_popupElement(place, onRecording), { maxWidth: 320, minWidth: 220 });
    cluster.addLayer(marker);
  }
  _map.addLayer(cluster);

  // Frame the places once the map has a size. A map drawn while its page is
  // hidden has none, and framing it then would leave it at the maximum zoom.
  const latlngs = data.points.map(p => [p.lat, p.lon]);
  let framed = false;
  const frame = () => {
    const { x, y } = _map.getSize();
    if (framed || !x || !y) return;
    framed = true;
    if (latlngs.length) _map.fitBounds(latlngs, { padding: [24, 24], maxZoom: 6 });
    else _map.setView([20, 0], 2);
  };
  _map.on('resize', frame);
  frame();
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => _map.invalidateSize()).observe(view.canvas);
  }

  view.count.textContent = data.recordingCount
    ? `${_plural(data.recordingCount, 'recording')} at ${_plural(data.points.length, 'place')}`
    : 'No recordings are of a specimen with coordinates yet.';
  view.note.textContent = data.unplacedCount
    ? `Not on the map: ${_plural(data.unplacedCount, 'recording')} with no specimen coordinates yet.`
    : '';
}
