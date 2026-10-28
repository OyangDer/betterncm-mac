// NCM version support levels (src/config.mjs ncmSupport).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ncmSupport } from '../src/config.mjs';

test('NCM 3.1.x is supported, other 3.x untested, 2.x and unreadable unsupported', () => {
  assert.equal(ncmSupport('3.1.14'), 'ok');
  assert.equal(ncmSupport('3.1.0'), 'ok');
  assert.equal(ncmSupport('3.2.0'), 'untested');
  assert.equal(ncmSupport('3.0.9'), 'untested');
  assert.equal(ncmSupport('4.0.0'), 'untested');
  assert.equal(ncmSupport('2.10.13'), 'unsupported');
  assert.equal(ncmSupport('0.0.0'), 'unsupported');
  assert.equal(ncmSupport('garbage'), 'unsupported');
});
