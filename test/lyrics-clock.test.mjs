// The lyrics page's playback clock (resources/lyrics/web/js/clock.js), loaded under Node with a
// fake performance.now().
import test from 'node:test';
import assert from 'node:assert/strict';

let t = 1000;
globalThis.window = globalThis;
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
globalThis.addEventListener = () => {};
globalThis.webkit = { messageHandlers: { b: { postMessage: () => {} } } };
Object.defineProperty(globalThis, 'performance', { value: { now: () => t }, configurable: true });

const clock = await import('../resources/lyrics/web/js/clock.js');
const receive = (m) => window.B.receive(m);

test('the position runs on between messages while playing, and stops when paused', () => {
  receive({ t: 'state', playing: true });
  receive({ t: 'progress', id: '1', pos: 10, wall: Date.now() });
  t += 250;
  assert.equal(clock.now(), 10250);
  receive({ t: 'state', playing: false });
  t += 5000;
  assert.equal(clock.now(), 10250);
});

test('without progress messages it runs on for two seconds at most (sleep with the state still playing)', () => {
  receive({ t: 'state', playing: true });
  receive({ t: 'progress', id: '1', pos: 60, wall: Date.now() });
  t += 8 * 3600 * 1000;
  assert.equal(clock.now(), 62000);
  // the next message sets it again
  receive({ t: 'progress', id: '1', pos: 61, wall: Date.now() });
  t += 250;
  assert.equal(clock.now(), 61250);
});
