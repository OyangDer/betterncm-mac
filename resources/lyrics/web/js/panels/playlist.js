// 播放列表: NCM's play queue, in the lyric column's place, instead of NCM's own drawer (which
// needed the window collapsed). The bridge reads the queue from NCM's store (queue) and plays an
// item of it as a double click in the drawer does (playItem); the queue itself is not changed.
import { registerPanel, loadCss } from './index.js';
import { request, send, on, log } from '../bus.js';
import { watch } from '../state.js';

loadCss('css/panel-playlist.css');

let root = null;
let list = null;
let count = null;
let shown = false;
let rows = new Map(); // id -> row element
let current = '';
let loading = null;

const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// NCM's image service resizes covers; 2x for the 40px thumbnails
const thumb = (url) => (url ? `${url.replace(/^http:/, 'https:')}?param=80y80` : '');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function markCurrent(id, scroll) {
  rows.get(current)?.classList.remove('current');
  current = id;
  const row = rows.get(id);
  if (!row) return;
  row.classList.add('current');
  // the playing song in the middle, as NCM's drawer opens on it
  if (scroll) list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
}

function render(q) {
  list.textContent = '';
  rows = new Map();
  count.textContent = q.total ? `${q.total} 首` : '';
  if (!q.items.length) {
    list.append(el('div', 'bncm-empty', '播放列表是空的'));
    return;
  }
  const frag = document.createDocumentFragment();
  q.items.forEach((it, i) => {
    const row = el('div', 'bncm-pl-row');
    row.dataset.id = it.id;
    const cover = el('div', 'bncm-pl-cover');
    if (it.cover) {
      const img = el('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = thumb(it.cover);
      cover.append(img);
    }
    cover.append(el('span', 'bncm-pl-index', String(i + 1)));
    const text = el('div', 'bncm-pl-text');
    text.append(el('div', 'bncm-pl-name', it.name), el('div', 'bncm-pl-artists', [it.artists, it.album].filter(Boolean).join(' · ')));
    row.append(cover, text, el('div', 'bncm-pl-time', it.duration ? fmt(it.duration) : ''));
    row.title = [it.name, it.artists].filter(Boolean).join(' - ');
    frag.append(row);
    rows.set(it.id, row);
  });
  list.append(frag);
  if (q.items.length < q.total) list.append(el('div', 'bncm-pl-more', `只显示前 ${q.items.length} 首`));
}

async function refresh(scroll) {
  if (loading) return loading;
  loading = (async () => {
    try {
      const q = await request('queue');
      render(q);
      markCurrent(q.current, scroll);
    } catch (e) {
      log('playlist: queue failed', String(e?.message || e));
      list.textContent = '';
      list.append(el('div', 'bncm-empty', '读取播放列表失败'));
    } finally {
      loading = null;
    }
  })();
  return loading;
}

registerPanel('playlist', {
  mount(container) {
    root = el('div', 'bncm-pl');
    const head = el('div', 'bncm-pl-head');
    count = el('span', 'bncm-pl-count');
    head.append(el('div', 'bncm-card-title', '播放列表'), count);
    list = el('div', 'bncm-scroll bncm-pl-list');
    root.append(head, list);
    container.append(root);
    list.addEventListener('click', (e) => {
      const row = e.target.closest?.('.bncm-pl-row');
      if (!row || row.dataset.id === current) return;
      send('playItem', { id: row.dataset.id });
      markCurrent(row.dataset.id, false); // at once; the track message confirms it
    });
  },
  show() {
    shown = true;
    refresh(true);
  },
  hide() {
    shown = false;
  },
});

// the song changed (NCM moved on, or a row was clicked): follow it if it is in the list
watch('track', (t) => {
  if (!shown || !t) return;
  if (rows.has(String(t.id))) markCurrent(String(t.id), !list.matches(':hover'));
  else refresh(true);
});
on('queueChanged', () => { if (shown) refresh(false); });
