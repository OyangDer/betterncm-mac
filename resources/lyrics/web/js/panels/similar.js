// 相似推荐: NCM's 相关歌单 and 相似歌曲 cards (IncludeSongCard, SimilarSongsCard). The lists come
// from music.163.com through NCM's page; the tags are worked out here the way NCM's own helpers
// (modules 34, 23, 314) work them out from the raw privilege. Clicks are handed to NCM
// (lyrics-actions-wiki.js) with the raw objects, which NCM formats as its cards do. Each card keeps
// the previous song's list until the new one has arrived, as NCM's do.
import { registerPanel, loadCss } from './index.js';
import { request, ncmFetch, send, host, log } from '../bus.js';
import { state, watch } from '../state.js';
import { ICONS } from '../icons.js';

loadCss('css/panel-similar.css');

const API = 'https://music.163.com/api';
const SKIP_MS = 300; // a quick run of skips fetches only the song it stops on
const PLAYLISTS_SHOWN = 6; // until 展开更多
const MENU_AFTER_MS = 400; // NCM's menu opens once its window is in front

// NCM's own icons (cmd-icon-*), 24x24 unless noted.
const I = {
  view_counts: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M19.44,12.66L19.44,13.61Q18.82,13.18,17.92,13.06Q17.29,12.97,16.8,13.37Q16.35,13.74,16.23,14.32L15.32,18.61Q15.13,19.53,15.66,20.26Q16.24,21.07,17.22,21Q18.83,20.9,19.73,19.93Q20.62,18.99,20.75,17.29Q20.76,17.14,20.76,16.99L20.77,16.99L20.77,16.84Q20.77,16.71,20.77,16.59L20.77,12.66Q20.77,10.71,20.09,8.92Q19.43,7.19,18.23,5.86Q17.02,4.51,15.44,3.77Q13.8,3,12.01,3Q10.21,3,8.57,3.77Q7,4.51,5.79,5.86Q4.58,7.19,3.92,8.92Q3.25,10.71,3.25,12.66L3.25,16.27Q3.21,16.75,3.25,17.29Q3.38,18.99,4.27,19.93Q5.17,20.9,6.78,21Q7.76,21.07,8.34,20.26Q8.88,19.53,8.68,18.61L7.77,14.32Q7.65,13.74,7.2,13.37Q6.71,12.97,6.08,13.06Q5.19,13.18,4.58,13.6L4.58,12.66Q4.58,9.19,6.78,6.74Q8.95,4.33,12.01,4.33Q15.06,4.33,17.24,6.74Q19.44,9.19,19.44,12.66Z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M6.1,5.76L6.1,18.24Q6.1,19.36,7.09,19.89Q8.06,20.4,9,19.83L13.97,16.77L19.09,13.62Q19.99,13.06,19.99,12Q19.99,10.94,19.09,10.38L13.97,7.23L9,4.17Q8.06,3.6,7.09,4.11Q6.1,4.64,6.1,5.76Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6,19L6,5C6,4.45,6.45,4,7,4L9,4C9.55,4,10,4.45,10,5L10,19C10,19.55,9.55,20,9,20L7,20C6.45,20,6,19.55,6,19ZM14,19L14,5C14,4.45,14.45,4,15,4L17,4C17.55,4,18,4.45,18,5L18,19C18,19.55,17.55,20,17,20L15,20C14.45,20,14,19.55,14,19Z"/></svg>',
  tagsmall: '<svg viewBox="0 0 6 6" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1.66,5.05L1.66,5.05Q1.61,5.11,1.58,5.18Q1.55,5.25,1.55,5.32L1.55,5.32Q1.55,5.33,1.55,5.34Q1.55,5.42,1.59,5.49Q1.62,5.56,1.68,5.62Q1.73,5.67,1.8,5.7Q1.87,5.72,1.95,5.72L1.95,5.72Q1.96,5.72,1.96,5.72Q2.04,5.72,2.12,5.69Q2.19,5.66,2.24,5.6L2.24,5.6L4.42,3.27Q4.44,3.25,4.46,3.21Q4.48,3.18,4.5,3.15Q4.51,3.11,4.52,3.07Q4.53,3.04,4.53,3Q4.53,2.96,4.52,2.92Q4.51,2.89,4.5,2.85Q4.48,2.82,4.46,2.79Q4.44,2.75,4.42,2.73L2.24,0.41Q2.19,0.35,2.12,0.32Q2.04,0.28,1.96,0.28Q1.96,0.28,1.95,0.28L1.94,0.28Q1.79,0.28,1.68,0.39Q1.62,0.44,1.59,0.51Q1.55,0.59,1.55,0.67Q1.55,0.67,1.55,0.68L1.55,0.69Q1.55,0.84,1.66,0.95L3.58,3L1.66,5.05Z"/></svg>',
  explicit: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M0,2.5L0,9.5Q0,9.62,0.01,9.75Q0.02,9.87,0.05,9.99Q0.07,10.11,0.11,10.23Q0.14,10.34,0.19,10.46Q0.24,10.57,0.3,10.68Q0.35,10.79,0.42,10.89Q0.49,10.99,0.57,11.09Q0.65,11.18,0.73,11.27Q0.82,11.35,0.91,11.43Q1.01,11.51,1.11,11.58Q1.21,11.65,1.32,11.7Q1.43,11.76,1.54,11.81Q1.66,11.86,1.77,11.89Q1.89,11.93,2.01,11.95Q2.13,11.98,2.25,11.99Q2.38,12,2.5,12L9.5,12Q9.62,12,9.75,11.99Q9.87,11.98,9.99,11.95Q10.11,11.93,10.23,11.89Q10.34,11.86,10.46,11.81Q10.57,11.76,10.68,11.7Q10.79,11.65,10.89,11.58Q10.99,11.51,11.09,11.43Q11.18,11.35,11.27,11.27Q11.35,11.18,11.43,11.09Q11.51,10.99,11.58,10.89Q11.65,10.79,11.7,10.68Q11.76,10.57,11.81,10.46Q11.86,10.34,11.89,10.23Q11.93,10.11,11.95,9.99Q11.98,9.87,11.99,9.75Q12,9.62,12,9.5L12,2.5Q12,2.38,11.99,2.25Q11.98,2.13,11.95,2.01Q11.93,1.89,11.89,1.77Q11.86,1.66,11.81,1.54Q11.76,1.43,11.7,1.32Q11.65,1.21,11.58,1.11Q11.51,1.01,11.43,0.91Q11.35,0.82,11.27,0.73Q11.18,0.65,11.09,0.57Q10.99,0.49,10.89,0.42Q10.79,0.35,10.68,0.3Q10.57,0.24,10.46,0.19Q10.34,0.14,10.23,0.11Q10.11,0.07,9.99,0.05Q9.87,0.02,9.75,0.01Q9.62,0,9.5,0L2.5,0Q2.38,0,2.25,0.01Q2.13,0.02,2.01,0.05Q1.89,0.07,1.77,0.11Q1.66,0.14,1.54,0.19Q1.43,0.24,1.32,0.3Q1.21,0.35,1.11,0.42Q1.01,0.49,0.91,0.57Q0.82,0.65,0.73,0.73Q0.65,0.82,0.57,0.91Q0.49,1.01,0.42,1.11Q0.35,1.21,0.3,1.32Q0.24,1.43,0.19,1.54Q0.14,1.66,0.11,1.77Q0.07,1.89,0.05,2.01Q0.02,2.13,0.01,2.25Q0,2.38,0,2.5ZM3.35,9.07L3.35,2.93C3.35,2.65,3.57,2.43,3.85,2.43L8.02,2.43C8.27,2.43,8.48,2.64,8.48,2.89C8.48,3.15,8.27,3.36,8.02,3.36L4.64,3.36C4.53,3.36,4.44,3.45,4.44,3.56L4.44,5.24C4.44,5.35,4.53,5.44,4.64,5.44L7.78,5.44C8.03,5.44,8.24,5.65,8.24,5.9C8.24,6.16,8.03,6.37,7.78,6.37L4.64,6.37C4.53,6.37,4.44,6.46,4.44,6.57L4.44,8.44C4.44,8.55,4.53,8.64,4.64,8.64L8.19,8.64C8.44,8.64,8.65,8.85,8.65,9.1C8.65,9.36,8.44,9.57,8.19,9.57L3.85,9.57C3.57,9.57,3.35,9.35,3.35,9.07Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M11.33,3.22C11.33,2.85,11.63,2.55,12,2.55C12.37,2.55,12.67,2.85,12.67,3.22L12.67,12.5L15.35,9.82C15.47,9.7,15.64,9.63,15.82,9.63C15.99,9.63,16.16,9.7,16.29,9.82C16.41,9.94,16.48,10.11,16.48,10.29C16.48,10.47,16.41,10.64,16.29,10.76L12.47,14.58C12.34,14.71,12.17,14.78,11.99,14.78C11.82,14.78,11.65,14.71,11.52,14.58L7.7,10.76C7.58,10.64,7.51,10.47,7.51,10.29C7.51,10.11,7.58,9.94,7.7,9.82C7.83,9.7,8,9.63,8.17,9.63C8.35,9.63,8.52,9.7,8.64,9.82L11.33,12.51L11.33,3.22ZM5.82,6.5C5.82,6.65,5.77,6.8,5.68,6.91Q3.84,9.1,3.84,11.93Q3.84,15.21,6.22,17.54Q8.61,19.87,12,19.87Q15.39,19.87,17.78,17.54Q20.16,15.21,20.16,11.93Q20.16,9.1,18.32,6.91C18.23,6.8,18.18,6.65,18.18,6.5C18.18,6.15,18.46,5.87,18.81,5.87C19,5.87,19.18,5.95,19.3,6.09Q21.44,8.63,21.44,11.93Q21.44,13.81,20.69,15.52Q19.97,17.17,18.67,18.45Q17.36,19.72,15.67,20.41Q13.92,21.14,12,21.14Q10.08,21.14,8.33,20.41Q6.64,19.72,5.33,18.45Q4.03,17.17,3.31,15.52Q2.56,13.81,2.56,11.93Q2.56,8.63,4.7,6.09C4.82,5.95,5,5.87,5.19,5.87C5.54,5.87,5.82,6.15,5.82,6.5Z"/></svg>',
  like: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M15.56,2.9Q13.56,2.9,12,4.13Q10.44,2.9,8.44,2.9Q5.89,2.9,4.1,4.87Q2.34,6.81,2.33,9.54Q2.33,11.82,3.5,13.86Q4.58,15.75,6.78,17.62Q8.29,18.9,10.02,20.05Q10.57,20.41,11.07,20.72Q11.32,20.88,11.48,20.96Q12,21.26,12.53,20.96Q12.68,20.88,12.93,20.72Q13.44,20.41,13.98,20.05Q15.71,18.9,17.22,17.62Q19.42,15.75,20.5,13.86Q21.66,11.82,21.66,9.54Q21.66,6.81,19.9,4.87Q18.11,2.9,15.56,2.9ZM12.46,5.49C12.2,5.74,11.8,5.74,11.54,5.49Q10.21,4.23,8.44,4.23Q6.48,4.23,5.08,5.76Q3.66,7.32,3.66,9.54Q3.66,11.46,4.65,13.2Q5.62,14.89,7.64,16.6Q9.09,17.83,10.76,18.95Q11.28,19.29,11.76,19.59Q11.9,19.67,12,19.73Q12.1,19.67,12.24,19.59Q12.72,19.29,13.24,18.95Q14.91,17.83,16.36,16.6Q18.38,14.89,19.35,13.2Q20.33,11.46,20.33,9.54Q20.33,7.32,18.92,5.76Q17.52,4.23,15.56,4.23Q13.79,4.23,12.46,5.49Z"/></svg>',
  collect: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M6,3.78L18,3.78C18.37,3.78,18.66,3.48,18.66,3.12C18.66,2.75,18.37,2.45,18,2.45L6,2.45C5.63,2.45,5.33,2.75,5.33,3.12C5.33,3.48,5.63,3.78,6,3.78ZM3.37,16.02L3.03,11.07Q2.91,9.28,2.95,8.65Q3.03,7.54,3.59,6.93Q4.16,6.32,5.26,6.17Q5.88,6.09,7.68,6.09L16.31,6.09Q18.12,6.09,18.74,6.17Q19.84,6.32,20.41,6.93Q20.97,7.54,21.05,8.65Q21.09,9.28,20.97,11.07L20.63,16.02Q20.49,18,20.36,18.68Q20.12,19.84,19.47,20.45Q18.82,21.05,17.64,21.21Q16.96,21.3,14.98,21.3L9.02,21.3Q7.04,21.3,6.36,21.21Q5.18,21.05,4.53,20.45Q3.88,19.84,3.64,18.68Q3.51,18,3.37,16.02ZM4.7,15.93Q4.83,17.82,4.95,18.41Q5.1,19.16,5.44,19.47Q5.78,19.79,6.53,19.89Q7.13,19.97,9.02,19.97L14.98,19.97Q16.87,19.97,17.47,19.89Q18.22,19.79,18.56,19.47Q18.9,19.16,19.05,18.41Q19.17,17.82,19.3,15.93L19.64,10.98Q19.76,9.28,19.72,8.74Q19.68,8.11,19.43,7.84Q19.19,7.58,18.56,7.49Q18.03,7.42,16.31,7.42L7.68,7.42Q5.97,7.42,5.44,7.49Q4.81,7.58,4.57,7.84Q4.32,8.11,4.28,8.74Q4.24,9.27,4.36,10.98L4.7,15.93ZM11.33,16.99L11.33,14.36L8.7,14.36C8.33,14.36,8.03,14.06,8.03,13.69C8.03,13.33,8.33,13.03,8.7,13.03L11.33,13.03L11.33,10.39C11.33,10.03,11.63,9.73,12,9.73C12.37,9.73,12.66,10.03,12.66,10.39L12.66,13.03L15.3,13.03C15.66,13.03,15.96,13.33,15.96,13.69C15.96,14.06,15.66,14.36,15.3,14.36L12.66,14.36L12.66,16.99C12.66,17.36,12.37,17.66,12,17.66C11.63,17.66,11.33,17.36,11.33,16.99Z"/></svg>',
  morefunctions: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.5,12C3.5,11.17,4.17,10.5,5,10.5C5.83,10.5,6.5,11.17,6.5,12C6.5,12.83,5.83,13.5,5,13.5C4.17,13.5,3.5,12.83,3.5,12ZM10.5,12C10.5,11.17,11.17,10.5,12,10.5C12.83,10.5,13.5,11.17,13.5,12C13.5,12.83,12.83,13.5,12,13.5C11.17,13.5,10.5,12.83,10.5,12ZM17.5,12C17.5,11.17,18.17,10.5,19,10.5C19.83,10.5,20.5,11.17,20.5,12C20.5,12.83,19.83,13.5,19,13.5C18.17,13.5,17.5,12.83,17.5,12Z"/></svg>',
};

/** Module 32 f: 21616, 10.6万, 1.2亿 (up to 100000 not abbreviated). */
export function fmtCount(n, threshold = 1e5) {
  if (n == null) return '';
  if (typeof n === 'string') { if (/^\d+(\.\d+)?[十百千万亿]+$/.test(n)) return n; n = parseInt(n, 10); }
  if (Number.isNaN(n)) return '';
  return String(n > 1e8 ? `${Math.floor(n / 1e7) / 10}亿` : n > threshold ? `${Math.floor(n / 1e3) / 10}万` : Math.floor(n));
}

// privilege.fee bits (module 7 l) and freeTrialPrivilege tag types (module 34)
const FEE_TS = 1;
const FEE_BB = 4;
const FEE_BT = 16;
const FEE_VIP_ONLY = 32;
const flagBit = (p, bit) => ((Number(p?.flag) || 0) >> bit & 1) === 1;

/** The tags NCM's title cell shows under a raw /api song, in its order. */
export function tagsOf(t, vinylVip) {
  const p = t.privilege;
  const tags = [];
  const noCopy = !!p && !t.programId && p.st < 0; // 34.j
  const rc = t.noCopyrightRcmd;
  const mvNoCopy = noCopy && !!rc?.mvInfo?.id; // 23.t, approximated: no source but an MV to watch
  const trial = p?.freeTrialPrivilege;
  const trialUser = !!(trial?.userConsumable && trial?.resConsumable);
  if (noCopy) {
    if (rc?.typeDesc && !mvNoCopy) tags.push({ k: 'nosrc', text: '无音源', extra: `${rc.typeDesc} |` });
  } else if (p) {
    // 314: the first quality that applies (flag bits 16 超清母带, 18 沉浸声, 17 高清臻音, 12 Hi-Res)
    const br = Math.ceil((Number(p.maxbr) || 0) / 1e3);
    const q = flagBit(p, 16) ? '超清母带' : flagBit(p, 18) ? '沉浸声' : flagBit(p, 17) ? '高清臻音'
      : flagBit(p, 12) ? 'Hi-Res' : br > 320 && br < 1999 ? 'SQ' : '';
    if (q) tags.push({ k: 'quality', text: q });
    const vip = trialUser ? ['VIP_AND_FREE_TAG', null].includes(trial.freeLimitTagType)
      : !!p.fee && !!(p.fee & (FEE_TS | FEE_BT | FEE_VIP_ONLY));
    if (vip) tags.push({ k: 'vip', text: 'VIP' });
    let audition = false;
    if (flagBit(p, 10) && !p.payed) audition = trialUser ? trial.freeLimitTagType === null : ((p.fee & FEE_TS) && !vinylVip) || !!(p.fee & FEE_BB);
    if (audition && !p.cs) tags.push({ k: 'trial', text: '试听' });
    if (trialUser && ['VIP_AND_FREE_TAG', 'FREE_TAG'].includes(trial.freeLimitTagType)) tags.push({ k: 'free', text: '限免' });
  }
  const mvId = String((mvNoCopy ? rc.mvInfo.id : t.mvid) || '');
  if (mvId && mvId !== '0' && !(noCopy && !mvNoCopy)) tags.push({ k: 'mv', text: 'MV', mvId });
  return tags;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const img = (url, size) => {
  if (!url) return '';
  const u = String(url).replace(/^http:/, 'https:');
  return `${u}${u.includes('?') ? '&' : '?'}param=${size}y${size}`;
};

// --- state ----------------------------------------------------------------------------------
let scroller = null;
let plCard = null;
let songCard = null;
let emptyEl = null;
let wantId = '';
let timer = 0;
let expanded = false; // 展开更多 (NCM resets it on every track change)
let ctx = { vinylVip: false, liked: {} };
const shown = { playlists: null, songs: null }; // {id, list, failed} on screen
const cache = new Map(); // `${kind}:${id}` -> list
const inflight = new Set();

// --- rendering --------------------------------------------------------------------------------
function renderPlaylists() {
  const s = shown.playlists;
  const list = s?.list || [];
  plCard.hidden = !list.length;
  updateEmpty();
  if (!list.length) { plCard.textContent = ''; return; }
  const items = expanded ? list : list.slice(0, PLAYLISTS_SHOWN);
  plCard.innerHTML = `<div class="bncm-card-title">相关歌单</div><div class="bncm-sim-grid">${items.map((p, i) => {
    const count = (typeof p.playCount === 'string' ? p.playCount : p.playCount > 0 ? fmtCount(p.playCount) : '');
    return `<div class="bncm-sim-pl" data-i="${i}" title="${esc(p.name)}">
      <div class="bncm-sim-plcover"><img src="${esc(img(p.coverImgUrl, 360))}" loading="lazy" decoding="async" width="180" height="180" alt="">
      ${count ? `<div class="bncm-sim-count">${I.view_counts}<span>${esc(count)}</span></div>` : ''}</div>
      <div class="bncm-sim-plname">${esc(p.name)}</div></div>`;
  }).join('')}</div>${!expanded && list.length > PLAYLISTS_SHOWN ? '<div class="bncm-sim-more">展开更多</div>' : ''}`;
}

function renderSongs() {
  const s = shown.songs;
  const list = s?.list || [];
  songCard.hidden = !list.length;
  updateEmpty();
  if (!list.length) { songCard.textContent = ''; return; }
  songCard.innerHTML = `<div class="bncm-card-title">相似歌曲<button class="bncm-sim-playall" type="button">${I.play}<span>播放</span></button></div>
    <div class="bncm-sim-list">${list.map((t, i) => songRow(t, i)).join('')}</div>`;
  markCurrent();
}

/** Both lists are in for this song (or it has none, like a local file) and both are empty. */
function updateEmpty() {
  const done = !wantId || (shown.playlists?.id === wantId && shown.songs?.id === wantId);
  emptyEl.hidden = !(done && plCard.hidden && songCard.hidden);
}

function songRow(t, i) {
  const tags = tagsOf(t, ctx.vinylVip);
  // NCM's no-copyright title: no source and no recommendation text in its place
  const noCopy = !!t.privilege && !t.programId && t.privilege.st < 0 && !t.noCopyrightRcmd?.typeDesc;
  const alias = [...(t.transNames || []), ...(t.alias || [])].find(Boolean);
  const explicit = typeof t.mark === 'number' ? (t.mark & 1 << 20) > 0 : !!t.album?.explicit;
  const artists = (t.artists || []).filter((a) => a?.name);
  const tagHtml = tags.map((x) => (x.k === 'mv'
    ? `<span class="bncm-sim-tag mv" data-mv="${esc(x.mvId)}" title="MV">MV${I.tagsmall}</span>`
    : `<span class="bncm-sim-tag ${x.k}">${esc(x.text)}</span>${x.extra ? `<span class="bncm-sim-tagnote">${esc(x.extra)}</span>` : ''}`)).join('');
  return `<div class="bncm-sim-row${noCopy ? ' nocopy' : ''}" data-i="${i}" data-id="${esc(t.id)}">
    <div class="bncm-sim-cover"><img src="${esc(img(t.album?.picUrl, 96))}" loading="lazy" decoding="async" width="48" height="48" alt="">
      <div class="bncm-sim-coverplay" data-act="one">${I.play}${I.pause}</div></div>
    <div class="bncm-sim-meta">
      <div class="bncm-sim-title" title="${esc(t.name || '未知歌曲')}"><span class="bncm-sim-name">${esc(t.name || '未知歌曲')}${alias ? `<span class="bncm-sim-alias">（${esc(alias)}）</span>` : ''}</span>${explicit ? `<span class="bncm-sim-explicit">${I.explicit}</span>` : ''}</div>
      <div class="bncm-sim-sub">${tagHtml ? `<div class="bncm-sim-tags">${tagHtml}</div>` : ''}<div class="bncm-sim-artists" title="${esc(artists.map((a) => a.name).join('/'))}">${artists.length
        ? artists.map((a, j) => `${j ? ' / ' : ''}<a data-artist="${j}">${esc(a.name)}</a>`).join('') : '未知歌手'}</div></div>
    </div>
    <div class="bncm-sim-extra"><div class="bncm-sim-tools">
      <button type="button" data-act="download" title="下载">${I.download}</button>
      <button type="button" data-act="like" title="喜欢" class="${ctx.liked[t.id] ? 'liked' : ''}">${I.like}${ICONS.heartActive}</button>
      <button type="button" data-act="favorite" title="收藏">${I.collect}</button>
      <button type="button" data-act="menu" title="更多">${I.morefunctions}</button>
    </div></div></div>`;
}

/** The row of the song now playing shows a pause button on its cover (NCM's title-playing). */
function markCurrent() {
  if (!songCard) return;
  const id = String(state.track?.id || '');
  for (const r of songCard.querySelectorAll('.bncm-sim-row')) {
    const cur = r.dataset.id === id;
    r.classList.toggle('current', cur);
    r.classList.toggle('paused', cur && !state.playing);
  }
}
watch('track', markCurrent);
watch('playing', markCurrent);

// --- data ---------------------------------------------------------------------------------------
const SOURCES = {
  playlists: (id) => ncmFetch(`${API}/discovery/simiPlaylist?songid=${id}`).then((r) => r?.playlists || []),
  songs: (id) => ncmFetch(`${API}/v1/discovery/simiSong?songid=${id}`).then((r) => r?.songs || []),
};

async function loadCtx(ids) {
  if (!ids.length) return;
  try {
    const c = await request('ncmAction', { action: 'wikiCtx', ids });
    if (c) ctx = { vinylVip: !!c.vinylVip, liked: { ...ctx.liked, ...c.liked } };
  } catch (e) {
    log('相似歌曲 ctx failed:', String(e?.message || e));
  }
}

function apply(kind, id, list, failed = false) {
  // the two lists arrive one after the other: only the first of a new song scrolls back up
  if (shown.playlists?.id !== id && shown.songs?.id !== id) scroller.scrollTop = 0;
  shown[kind] = { id, list, failed };
  if (kind === 'playlists') renderPlaylists(); else renderSongs();
}

async function load(kind, id) {
  const key = `${kind}:${id}`;
  if (cache.has(key)) { apply(kind, id, cache.get(key)); return; }
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    const list = await SOURCES[kind](id);
    if (kind === 'songs') await loadCtx(list.map((t) => String(t.id)));
    cache.set(key, list);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    if (wantId === id) apply(kind, id, list);
  } catch (e) {
    log(`相似推荐 ${kind} failed:`, id, String(e?.message || e));
    // the previous song's list stays; with none, this card is empty until the next try
    if (wantId === id && !shown[kind]) apply(kind, id, [], true);
  } finally {
    inflight.delete(key);
  }
}

function loadAll(id) {
  load('playlists', id);
  load('songs', id);
}

// --- clicks -------------------------------------------------------------------------------------
let busy = false; // NCM throttles its click handlers; one hand-off at a time is enough here
async function act(fields, collapse) {
  if (busy) return;
  busy = true;
  try {
    await request('ncmAction', fields);
    if (collapse) host('close');
  } catch (e) {
    log('相似推荐 action failed:', fields.action, String(e?.message || e));
  } finally {
    setTimeout(() => { busy = false; }, 150);
  }
}

const songsNow = () => shown.songs?.list || [];

function onClick(e) {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const pl = el.closest('.bncm-sim-pl');
  if (pl) {
    const p = shown.playlists?.list[Number(pl.dataset.i)];
    if (p) act({ action: 'wikiOpen', kind: 'playlist', id: String(p.id), resource: p }, true);
    return;
  }
  if (el.closest('.bncm-sim-more')) { expanded = true; renderPlaylists(); return; }
  if (el.closest('.bncm-sim-playall')) { act({ action: 'wikiPlay', how: 'all', songs: songsNow() }); return; }
  const row = el.closest('.bncm-sim-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  const t = songsNow()[i];
  if (!t) return;
  const a = el.closest('[data-artist]');
  if (a) {
    const ar = t.artists?.[Number(a.dataset.artist)];
    if (ar?.id) act({ action: 'wikiOpen', kind: 'artist', id: String(ar.id), resource: { id: String(ar.id), name: ar.name } }, true);
    return;
  }
  const mv = el.closest('[data-mv]');
  if (mv) { act({ action: 'wikiOpen', kind: 'mv', id: mv.dataset.mv }, true); return; }
  const what = el.closest('[data-act]')?.dataset.act;
  if (what === 'one') {
    if (row.classList.contains('current')) send('toggle');
    else act({ action: 'wikiPlay', how: 'one', songs: [t], index: 0 });
  } else if (what === 'like') {
    const like = !ctx.liked[t.id];
    ctx.liked[t.id] = like;
    el.closest('button').classList.toggle('liked', like);
    act({ action: 'wikiTrack', op: 'like', like, song: t }).then(() => setTimeout(() => loadCtx([String(t.id)]).then(renderSongs), 800));
  } else if (what === 'favorite') {
    act({ action: 'wikiTrack', op: 'favorite', song: t }, true);
  } else if (what === 'download') {
    act({ action: 'wikiTrack', op: 'download', song: t });
  } else if (what === 'menu') {
    openMenu(t, e);
  }
}

// NCM's track menu opens in NCM's window, which takes the lyrics window's place at the same frame,
// so the pointer's position is the menu's position there too.
function openMenu(t, e) {
  host('close');
  setTimeout(() => act({ action: 'wikiTrack', op: 'menu', song: t, x: e.clientX, y: e.clientY }), MENU_AFTER_MS);
}

function onDblClick(e) {
  const el = e.target instanceof Element ? e.target : null;
  const row = el?.closest('.bncm-sim-row');
  if (!row || el.closest('button, a, [data-mv], [data-act]')) return;
  const i = Number(row.dataset.i);
  if (songsNow()[i]) act({ action: 'wikiPlay', how: 'dbl', songs: songsNow(), index: i });
}

function onContextMenu(e) {
  const row = e.target instanceof Element && e.target.closest('.bncm-sim-row');
  const t = row && songsNow()[Number(row.dataset.i)];
  if (!t) return;
  e.preventDefault();
  openMenu(t, e);
}

registerPanel('similar', {
  mount(el) {
    scroller = document.createElement('div');
    scroller.className = 'bncm-scroll';
    plCard = document.createElement('div');
    plCard.className = 'bncm-card bncm-sim-plcard';
    songCard = document.createElement('div');
    songCard.className = 'bncm-card bncm-sim-songcard';
    plCard.hidden = true;
    songCard.hidden = true;
    emptyEl = document.createElement('div');
    emptyEl.className = 'bncm-empty';
    emptyEl.textContent = '暂无相似推荐';
    emptyEl.hidden = true;
    scroller.append(plCard, songCard, emptyEl);
    el.append(scroller);
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDblClick);
    el.addEventListener('contextmenu', onContextMenu);
  },
  show(t) {
    const id = t && !t.local && /^\d+$/.test(String(t.id)) ? String(t.id) : '';
    clearTimeout(timer);
    if (id !== wantId) expanded = false;
    wantId = id;
    updateEmpty();
    if (!id) { shown.playlists = null; shown.songs = null; renderPlaylists(); renderSongs(); return; }
    const { playlists: p, songs: s } = shown;
    if (p?.id === id && s?.id === id && !p.failed && !s.failed) { markCurrent(); return; }
    const first = !shown.playlists && !shown.songs;
    if (first || cache.has(`songs:${id}`)) loadAll(id);
    else timer = setTimeout(() => { if (wantId === id && state.view === 'similar') loadAll(id); }, SKIP_MS);
  },
  hide() {
    clearTimeout(timer);
  },
});
