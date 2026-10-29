/**
 * ui.js — Shared UI helpers for corpus sites
 */

import { esc } from './format.js';

// esc is in format.js, which the tools share. It is exported from here too,
// for the modules that import it from ui.js.
export { esc };

/** Shared play/pause SVG icons used by player.js and render.js */
export const ICON_PLAY  = `<svg viewBox="0 0 10 12"><polygon points="0,0 10,6 0,12"/></svg>`;
export const ICON_PAUSE = `<svg viewBox="0 0 10 12">
  <rect x="1" y="1" width="3" height="10" rx="1"/>
  <rect x="6" y="1" width="3" height="10" rx="1"/>
</svg>`;

/** Render a loading spinner into an element */
export function showLoading(el, message = 'Loading…') {
  el.innerHTML = `
    <div class="loading" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      ${esc(message)}
    </div>`;
}

/** Render an error message into an element */
export function showError(el, message) {
  el.innerHTML = `<div class="error-msg" role="alert">${esc(message)}</div>`;
}

/** Render an empty state into an element */
export function showEmpty(el, message = 'No results found.') {
  el.innerHTML = `
    <div class="empty" role="status">
      <div class="empty-icon" aria-hidden="true">🔇</div>
      <p>${esc(message)}</p>
    </div>`;
}

/**
 * Build a hero waveform decoration into the given element.
 * @param {HTMLElement} el
 */
export function buildHeroWaveform(el) {
  if (!el) return;
  const heights = [20,35,55,80,60,90,70,45,85,65,40,75,50,88,62,42,78,55,35,68,45,82,60,38,72];
  let html = '<div class="waveform-bars">';
  heights.forEach((h, i) => {
    const delay = (i * 0.08).toFixed(2);
    const dur   = (1.5 + i * 0.05).toFixed(2);
    html += `<div class="bar" style="height:${h}%;animation-delay:${delay}s;animation-duration:${dur}s"></div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

/**
 * Render pagination controls.
 * @param {HTMLElement} el         - container element
 * @param {number}      totalPages - total number of pages (use last_page from API)
 * @param {number}      current    - current page (1-indexed)
 * @param {Function}    onPage     - callback(pageNumber)
 */
export function renderPagination(el, totalPages, current, onPage) {
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  el.setAttribute('role', 'navigation');
  el.setAttribute('aria-label', 'Pagination');

  const range = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= current - 2 && p <= current + 2)) {
      range.push(p);
    } else if (range[range.length - 1] !== '…') {
      range.push('…');
    }
  }

  let html = `
    <button class="page-btn" ${current === 1 ? 'disabled' : ''} data-p="${current - 1}"
            aria-label="Previous page">‹ prev</button>`;
  range.forEach(p => {
    if (p === '…') {
      html += `<span class="page-btn" aria-hidden="true" style="border:none;cursor:default">…</span>`;
    } else {
      const isCurrent = p === current;
      html += `<button class="page-btn ${isCurrent ? 'current' : ''}" data-p="${p}"
                       aria-label="Page ${p}"${isCurrent ? ' aria-current="page"' : ''}>${p}</button>`;
    }
  });
  html += `
    <button class="page-btn" ${current === totalPages ? 'disabled' : ''} data-p="${current + 1}"
            aria-label="Next page">next ›</button>`;

  el.innerHTML = html;
  el.querySelectorAll('button[data-p]').forEach(btn => {
    btn.addEventListener('click', () => onPage(Number(btn.dataset.p)));
  });
}
