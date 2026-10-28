// src/prelude/compat-rnp-top-controls.js in a vm context with a fake page: the settings and copy
// mode buttons join RNPN's tool row, click RNPN's own controls and mirror their state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/compat-rnp-top-controls.js'), 'utf8');

class El {
  constructor(tag, className = '') { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = className; this.parent = null; }
  get classList() {
    const el = this;
    const set = () => new Set(el.className.split(' ').filter(Boolean));
    return {
      contains: (c) => set().has(c),
      toggle: (c, on) => { const s = set(); if (on) s.add(c); else s.delete(c); el.className = [...s].join(' '); },
    };
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); }
  querySelector(sel) { return this.children.find((c) => c.classList.contains(sel.slice(1))) ?? null; }
}

function load() {
  const page = {
    tools: new El('div', 'rnp-window-tools'),
    input: new El('input', 'rnp-settings'),
    copyMode: new El('button', 'rnp-lyrics-switch-btn rnp-lyrics-switch-btn-overview-mode'),
    hasCopyMode: true,
  };
  page.tools.appendChild(new El('button', 'rnp-window-tool rnp-window-tool-plugin-close'));
  page.input.checked = false;
  page.input.click = () => { page.input.checked = !page.input.checked; };
  page.copyMode.click = () => { page.copyMode.classList.toggle('active', !page.copyMode.classList.contains('active')); };
  const timers = [];
  const doc = {
    readyState: 'complete',
    head: new El('head'),
    getElementById: () => null,
    createElement: (t) => new El(t),
    querySelector: (sel) => {
      if (sel === '#rnp-view .rnp-window-tools') return page.tools;
      if (sel === '#rnp-settings') return page.input;
      if (sel.endsWith('overview-mode')) return page.hasCopyMode ? page.copyMode : null;
      return null;
    },
    addEventListener: () => {},
  };
  vm.runInContext(CODE, vm.createContext({
    document: doc,
    setInterval: (fn) => { page.tick = fn; },
    setTimeout: (fn) => { timers.push(fn); },
  }));
  page.flush = () => { while (timers.length) timers.shift()(); };
  page.btn = (cls) => page.tools.children.find((c) => c.classList.contains(cls));
  return page;
}

test('the close button reads as collapse and the two buttons join the row', () => {
  const p = load();
  const close = p.tools.children[0];
  assert.equal(close.title, '收起');
  assert.equal(close.attrs['aria-label'], '收起');
  assert.equal(p.btn('bncm-top-settings').title, '设置');
  assert.equal(p.btn('bncm-top-copy').title, '复制模式');
  p.tick();
  assert.equal(p.tools.children.length, 3, 'not added twice');
});

test('the buttons click RNPN\'s controls and show their state', () => {
  const p = load();
  const settings = p.btn('bncm-top-settings');
  settings.click();
  p.flush();
  assert.equal(p.input.checked, true);
  assert.ok(settings.classList.contains('bncm-on'));
  settings.click();
  p.flush();
  assert.ok(!settings.classList.contains('bncm-on'));
  const copy = p.btn('bncm-top-copy');
  copy.click();
  p.flush();
  assert.ok(p.copyMode.classList.contains('active'));
  assert.ok(copy.classList.contains('bncm-on'));
});

test('copy mode is hidden without RNPN\'s button, and a re-rendered row gets the buttons back', () => {
  const p = load();
  p.hasCopyMode = false;
  p.tick();
  assert.equal(p.btn('bncm-top-copy').hidden, true);
  p.tools.children = p.tools.children.slice(0, 1); // RNPN rendered the row again
  p.tick();
  assert.ok(p.btn('bncm-top-settings'));
  assert.ok(p.btn('bncm-top-copy'));
});
