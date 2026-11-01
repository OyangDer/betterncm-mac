// Shared state with change notifications. Modules read `state.x` and subscribe with watch('x', fn).
const watchers = new Map();

export const state = {
  track: null, // {id, title, alias, trans, artists, album, duration, cover, quality, threadId, ...}
  playing: false,
  liked: false,
  mode: 'repeat',
  volume: 0.5,
  roaming: false,
  window: { w: innerWidth, h: innerHeight, visible: true, fullscreen: false },
  settings: null, // settings.js
  accent: null, // accent.js: {dark: {...}, light: {...}}
  cover: null, // {url, cover, bg}: asset URLs from the host
  lyrics: null, // parse.js output for state.track.id
  view: 'lyrics', // lyrics | baike | similar | comment
  scheme: 'dark', // resolved colour scheme
  version: '', // BetterNCM's version, sent with open
};

export function set(key, value) {
  const old = state[key];
  state[key] = value;
  for (const fn of watchers.get(key) || []) {
    try { fn(value, old); } catch (e) { console.error(`watcher of ${key} failed`, e); }
  }
}

export function watch(key, fn) {
  if (!watchers.has(key)) watchers.set(key, new Set());
  watchers.get(key).add(fn);
  return () => watchers.get(key)?.delete(fn);
}
