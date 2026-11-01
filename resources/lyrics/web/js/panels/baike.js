// 百科: NCM's 音乐百科 card (BaiKeCard). Its data is a signed request that only NCM's page can make
// (lyrics-actions-wiki.js wikiGet); the rows come from the server and are mapped as NCM's module
// 108 maps them. Like NCM, the previous song's card stays until the new one has arrived.
import { registerPanel, loadCss } from './index.js';
import { request, log } from '../bus.js';
import { state } from '../state.js';

loadCss('css/panel-baike.css');

const SKIP_MS = 300; // a quick run of skips fetches only the song it stops on
const cache = new Map(); // song id -> rows (null: no 百科 for that song)
let scroller = null;
let shownId = null; // the song whose card is on screen ('' when it shows the empty state)
let wantId = '';
const inflight = new Set();
let timer = 0;

/** Module 108 _(): rows of {title, content}, or null when NCM shows no card. */
function mapWiki(r) {
  if (!r || r.code !== 200) return null;
  const els = r.data?.wikiSubBlockBaseInfoVo?.wikiSubElementVos;
  if (!els?.length) return null;
  const rows = els
    .filter((e) => e.title && (e.content || e.wikiSubMetaVos))
    .map((e) => ({
      title: e.title,
      content: e.pattern === 1 ? (e.wikiSubMetaVos || []).map((m) => m.text).join('、') : String(e.content ?? ''),
    }));
  return rows.length ? rows : null;
}

function render(id, rows) {
  shownId = id;
  scroller.textContent = '';
  scroller.scrollTop = 0;
  if (!rows) {
    const empty = document.createElement('div');
    empty.className = 'bncm-empty';
    empty.textContent = '暂无百科信息';
    scroller.append(empty);
    return;
  }
  const card = document.createElement('div');
  card.className = 'bncm-card bncm-baike-card';
  const title = document.createElement('div');
  title.className = 'bncm-card-title';
  title.textContent = '音乐百科';
  const list = document.createElement('div');
  list.className = 'bncm-baike-rows';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'bncm-baike-row';
    const k = document.createElement('div');
    k.className = 'bncm-baike-label';
    k.textContent = r.title;
    const v = document.createElement('div');
    v.className = 'bncm-baike-value';
    v.textContent = r.content;
    row.append(k, v);
    list.append(row);
  }
  card.append(title, list);
  scroller.append(card);
}

async function load(id) {
  if (inflight.has(id)) return;
  inflight.add(id);
  let rows;
  try {
    rows = mapWiki(await request('ncmAction', { action: 'wikiGet', songId: id }));
  } catch (e) {
    // NCM keeps whatever it showed when the request fails; so do we, and try again next time
    log('百科 failed:', id, String(e?.message || e));
    if (wantId === id && shownId === null) render('', null);
    return;
  } finally {
    inflight.delete(id);
  }
  cache.set(id, rows);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  if (wantId === id) render(id, rows);
}

registerPanel('baike', {
  mount(el) {
    scroller = document.createElement('div');
    scroller.className = 'bncm-scroll';
    el.append(scroller);
  },
  show(t) {
    const id = t && !t.local && /^\d+$/.test(String(t.id)) ? String(t.id) : '';
    wantId = id;
    clearTimeout(timer);
    if (id === shownId) return;
    if (!id) { render('', null); return; }
    if (cache.has(id)) { render(id, cache.get(id)); return; }
    if (shownId === null) load(id);
    else timer = setTimeout(() => { if (wantId === id && state.view === 'baike') load(id); }, SKIP_MS);
  },
  hide() {
    clearTimeout(timer);
  },
});
