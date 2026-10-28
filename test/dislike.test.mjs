// src/prelude/compat-rnp-dislike.js in a vm context with a fake page: the button appears in
// RNPN's controls only while NCM shows its roaming dislike button, and forwards clicks to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/compat-rnp-dislike.js'), 'utf8');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.parent = null; }
  get classList() {
    const el = this;
    const set = () => new Set(el.className.split(' ').filter(Boolean));
    return {
      contains: (c) => set().has(c),
      toggle: (c, on) => { const s = set(); if (on) s.add(c); else s.delete(c); el.className = [...s].join(' '); },
    };
  }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); }
  querySelector(sel) { return sel === 'svg' ? this.svg ?? null : this.children.find((c) => sel === `.${c.className.split(' ').pop()}`) ?? null; }
  querySelectorAll() { return []; }
  cloneNode() { const c = new El(this.tagName); c.querySelectorAll = () => []; return c; }
}

function load({ roaming }) {
  const body = new El('body');
  const controls = new El('div');
  const native = new El('button');
  native.svg = new El('svg');
  let nativeClicks = 0;
  native.click = () => { nativeClicks++; };
  let tick = null;
  const doc = {
    readyState: 'complete',
    body,
    head: new El('head'),
    getElementById: () => null,
    createElement: (t) => new El(t),
    querySelector: (sel) => {
      if (sel.includes('tid_fmdislike_btn')) return state.roaming ? native : null;
      if (sel === '#rnp-view .am-music-controls') return controls;
      return null;
    },
    addEventListener: () => {},
  };
  const state = { roaming };
  vm.runInContext(CODE, vm.createContext({ document: doc, setInterval: (fn) => { tick = fn; } }));
  return { body, controls, state, tick: () => tick(), clicks: () => nativeClicks };
}

test('roaming: the button is added to RNPN controls and clicks NCM\'s', () => {
  const p = load({ roaming: true });
  assert.ok(p.body.classList.contains('bncm-roaming'));
  const btn = p.controls.lastElementChild;
  assert.ok(btn.classList.contains('bncm-rnp-dislike'));
  assert.equal(btn.title, '减少推荐');
  btn.click();
  assert.equal(p.clicks(), 1);
  p.tick();
  assert.equal(p.controls.children.length, 1, 'not added twice');
});

test('not roaming: nothing is added and the roaming class is cleared', () => {
  const p = load({ roaming: true });
  p.state.roaming = false;
  p.tick();
  assert.ok(!p.body.classList.contains('bncm-roaming'));
  const q = load({ roaming: false });
  assert.equal(q.controls.children.length, 0);
});

test('a re-rendered controls row gets the button back at its end', () => {
  const p = load({ roaming: true });
  p.controls.appendChild(new El('button')); // RNPN re-rendered after ours
  p.tick();
  assert.ok(p.controls.lastElementChild.classList.contains('bncm-rnp-dislike'));
  assert.equal(p.controls.children.filter((c) => c.classList.contains('bncm-rnp-dislike')).length, 1);
});
