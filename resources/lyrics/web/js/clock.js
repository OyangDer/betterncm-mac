// Playback position. The bridge sends progress about four times a second with the wall time it was
// read at; between messages the position runs on this page's own clock (RNPN's lyric clock:
// now = last + (playing ? elapsed : 0)).
import { on } from './bus.js';
import { state, set } from './state.js';

let last = 0; // ms at `at`
let at = performance.now();
let id = '';
let seekCounter = 0;
const listeners = new Set();

export function now() {
  return last + (state.playing ? performance.now() - at : 0);
}

export function trackId() { return id; }
export function seeks() { return seekCounter; }

/** fn(kind): 'tick' on every progress message, 'jump' after a seek or track change, 'state' on play/pause. */
export function onClock(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(kind) {
  for (const fn of listeners) {
    try { fn(kind); } catch (e) { console.error('clock listener failed', e); }
  }
}

export function setPosition(ms, kind = 'jump') {
  last = ms;
  at = performance.now();
  if (kind === 'jump') seekCounter++;
  notify(kind);
}

on('progress', (m) => {
  const pos = Number(m.pos) * 1000;
  if (!Number.isFinite(pos)) return;
  // rebase from the bridge's wall clock to ours
  const age = Math.max(0, Math.min(2000, Date.now() - Number(m.wall || Date.now())));
  const prev = now();
  const newId = String(m.id || '');
  last = pos + (state.playing ? age : 0);
  at = performance.now();
  const jumped = m.force || newId !== id || Math.abs(last - prev) > 400;
  id = newId;
  if (jumped) seekCounter++;
  notify(jumped ? 'jump' : 'tick');
});

/** Play or pause from here on: the position so far is kept, so the clock does not count the time it was stopped. */
export function setPlaying(v) {
  last = now();
  at = performance.now();
  set('playing', !!v);
  notify('state');
}

on('state', (m) => setPlaying(m.playing));
