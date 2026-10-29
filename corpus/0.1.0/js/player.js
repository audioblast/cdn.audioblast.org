/**
 * player.js — Global audio playback for corpus sites
 *
 * Only one track plays at a time. Calling play() on the currently
 * playing track toggles it off.
 */

import { ICON_PLAY, ICON_PAUSE } from './ui.js';

const audio = document.getElementById('global-audio');
let _playingId = null;

/**
 * Toggle playback for a recording.
 * @param {string} url  - audio file URL
 * @param {string} id   - unique recording id (used to find .play-btn element)
 */
export function togglePlay(url, id) {
  if (!url) return;

  // Clicking the currently playing track → pause it
  if (_playingId === id) {
    audio.pause();
    audio.src = '';
    _setButton(id, false);
    _playingId = null;
    return;
  }

  // Stop whatever was playing before
  if (_playingId) {
    _setButton(_playingId, false);
  }

  audio.src = url;
  _playingId = id;
  window.dispatchEvent(new Event('corpus:cardplay'));
  // Don't flip the button to "playing" until the browser confirms playback
  // started. Otherwise a rejected play() (autoplay block, 404) leaves a
  // permanently-spinning button.
  audio.play().catch(() => {
    if (_playingId === id) {
      _setButton(id, false);
      _playingId = null;
    }
  });
}

audio.addEventListener('play', () => {
  if (_playingId) _setButton(_playingId, true);
});
audio.addEventListener('pause', () => {
  if (_playingId) _setButton(_playingId, false);
});
audio.addEventListener('ended', () => {
  if (_playingId) _setButton(_playingId, false);
  _playingId = null;
});
audio.addEventListener('error', () => {
  if (_playingId) _setButton(_playingId, false);
  _playingId = null;
});

function _setButton(id, playing) {
  const btn = document.getElementById(`play-${id}`);
  if (!btn) return;
  btn.classList.toggle('playing', playing);
  btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}
