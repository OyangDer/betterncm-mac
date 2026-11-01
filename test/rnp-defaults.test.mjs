// src/prelude/compat-rnp-defaults.js in a vm context: it fills in RefinedNowPlayingNext settings
// the user has never set, and leaves set ones alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/compat-rnp-defaults.js'), 'utf8');
const KEY = 'refined-now-playing-album-size';

function run(initial) {
  const store = new Map(Object.entries(initial));
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  vm.runInContext(CODE, vm.createContext({ localStorage }));
  return Object.fromEntries(store);
}

test('an unset cover resolution defaults to the slider top', () => {
  assert.equal(run({})[KEY], '800');
});

test('a resolution the user chose (or reset to 200) is kept', () => {
  assert.equal(run({ [KEY]: '200' })[KEY], '200');
  assert.equal(run({ [KEY]: '600' })[KEY], '600');
});

test('no storage is not an error', () => {
  assert.doesNotThrow(() => vm.runInContext(CODE, vm.createContext({ localStorage: { getItem() { throw new Error('denied'); } } })));
});
