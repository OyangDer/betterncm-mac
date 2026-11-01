// 评论: NCM's vinyl comment tab (CommentArea.tsx, CommentCard.jsx, RichParagraph; bspec
// panels-visual.md §3, api-comment.md), rebuilt from the same API. The list is read with the plain
// GET from NCM's page; liking, replying, publishing, sharing and NCM's routes are handed to NCM
// (lyrics-actions-comment.js). Its dialogs open in NCM's window, so those collapse this one first.
import { registerPanel, loadCss } from './index.js';
import { ncmFetch, request, log } from '../bus.js';
import { state } from '../state.js';
import { collapse } from '../main.js';

loadCss('css/panel-comment.css');

const PAGE = 60; // NCM's PAGE_LIMIT
const HOT_SHOWN = 5;
const SKIP_MS = 600; // NCM waits this long after a track change before it loads
const PREFETCH_PX = 600; // the next page loads this far before the end of the list
const MODAL_TIMEOUT = 30 * 60 * 1000; // a publish dialog resolves when the user sends or cancels it
const API = (tid, offset) => `https://interface.music.163.com/api/v1/resource/comments/${encodeURIComponent(tid)}?limit=${PAGE}&offset=${offset}`;

const ICON = {
  praise: '<path fill="currentColor" fill-rule="evenodd" d="M15.72,6.66Q15.72,7.938,15.512,8.867L17.097,8.867Q17.136,8.867,17.234,8.866Q18.994,8.841,19.954,9.521Q21.747,10.791,21.161,14.127Q20.804,16.165,20.427,17.274Q19.934,18.725,19.124,19.574Q18.239,20.503,16.804,20.915Q15.444,21.305,13.306,21.305L6.007,21.305Q4.637,21.305,3.666,20.337Q2.694,19.369,2.694,17.999L2.694,13.025Q2.694,11.651,3.666,10.684Q4.635,9.719,6.008,9.719L7.106,9.719Q8.209,9.696,8.962,9.033Q9.879,8.226,9.879,6.66Q9.879,2.696,12.767,2.695Q13.824,2.695,14.585,3.381Q15.72,4.403,15.72,6.66ZM14.39,6.66Q14.39,4.995,13.695,4.369Q13.313,4.025,12.767,4.025Q11.894,4.025,11.541,4.711Q11.209,5.358,11.209,6.66Q11.209,8.827,9.841,10.031Q8.769,10.975,7.265,11.044L7.265,19.975L13.306,19.975Q16.904,19.975,18.162,18.656Q18.769,18.02,19.168,16.847Q19.511,15.834,19.852,13.897Q20.292,11.39,19.186,10.606Q18.579,10.177,17.253,10.196Q17.145,10.197,17.097,10.197L15.434,10.197Q14.812,10.197,14.431,9.664Q14.079,9.17,14.21,8.598Q14.39,7.807,14.39,6.66ZM5.935,19.974L5.935,11.05Q5.159,11.075,4.604,11.626Q4.024,12.204,4.024,13.025L4.024,17.999Q4.024,18.816,4.605,19.396Q5.161,19.949,5.935,19.974ZM15.506,8.894Q15.507,8.89,15.508,8.885Q15.512,8.888,15.514,8.891L15.506,8.894Z"/>',
  liked: '<path fill="currentColor" fill-rule="evenodd" d="M15.424,7.715Q15.579,6.919,15.579,5.805Q15.579,3.656,14.484,2.669Q13.741,2,12.711,2Q9.902,2.001,9.902,5.805Q9.902,7.196,9.098,7.903Q8.782,8.18,8.4,8.329L8.4,19.5L13.21,19.5Q15.209,19.5,16.486,19.133Q17.849,18.742,18.694,17.856Q19.465,17.048,19.93,15.677Q20.283,14.639,20.616,12.742Q21.173,9.57,19.443,8.345Q18.518,7.69,16.845,7.713Q16.755,7.715,16.72,7.715L15.424,7.715ZM6.6,19.5L6.6,8.503L6.453,8.503Q5.126,8.503,4.189,9.436Q3.25,10.371,3.25,11.699L3.25,16.304Q3.25,17.628,4.189,18.565Q5.127,19.5,6.452,19.5L6.6,19.5Z"/>',
  share: '<path fill="currentColor" fill-rule="evenodd" d="M12,4.165Q8.755,4.165,6.46,6.46Q4.165,8.755,4.165,12Q4.165,15.245,6.46,17.54Q8.755,19.835,12,19.835Q15.245,19.835,17.54,17.54Q19.835,15.245,19.835,12C19.835,11.633,20.133,11.335,20.5,11.335C20.867,11.335,21.165,11.633,21.165,12Q21.165,13.864,20.444,15.568Q19.749,17.213,18.481,18.481Q17.212,19.749,15.568,20.445Q13.864,21.165,12,21.165Q10.136,21.165,8.432,20.445Q6.788,19.749,5.519,18.481Q4.251,17.213,3.556,15.568Q2.835,13.864,2.835,12Q2.835,10.136,3.556,8.432Q4.251,6.788,5.519,5.519Q6.788,4.251,8.432,3.556Q10.136,2.835,12,2.835C12.367,2.835,12.665,3.133,12.665,3.5C12.665,3.867,12.367,4.165,12,4.165ZM17.435,4.477L19.552,6.333Q19.841,6.586,19.849,6.97Q19.857,7.353,19.58,7.618L17.573,9.534C17.45,9.653,17.285,9.718,17.114,9.718C16.747,9.718,16.449,9.421,16.449,9.053C16.449,8.872,16.523,8.698,16.655,8.573L17.636,7.636Q15.659,7.676,14.504,8.573Q13.114,9.654,12.816,12.08L12.816,12.08C12.775,12.414,12.492,12.664,12.156,12.664C11.788,12.664,11.491,12.367,11.491,11.999C11.491,11.972,11.492,11.945,11.496,11.918L11.496,11.918Q11.862,8.943,13.688,7.523Q15.158,6.38,17.507,6.309L16.558,5.477C16.414,5.35,16.331,5.168,16.331,4.977C16.331,4.609,16.629,4.312,16.996,4.312C17.157,4.312,17.313,4.37,17.435,4.477Z"/>',
  reply: '<path fill="currentColor" fill-rule="evenodd" d="M12,21.148L5.283,21.148Q4.411,21.148,3.935,20.466Q3.433,19.746,3.818,18.902L4.024,18.45L4.271,17.905Q4.562,17.265,4.191,16.652Q2.852,14.442,2.852,12Q2.852,10.068,3.625,8.314Q4.372,6.62,5.724,5.344Q7.08,4.065,8.82,3.42Q10.63,2.749,12.582,2.87Q14.046,2.961,15.408,3.514Q17.823,4.493,19.378,6.61Q20.966,8.771,21.13,11.417Q21.251,13.37,20.58,15.18Q19.935,16.92,18.656,18.276Q17.38,19.628,15.686,20.375Q13.932,21.148,12,21.148ZM12,19.852Q13.659,19.852,15.164,19.189Q16.618,18.548,17.713,17.387Q18.812,16.222,19.365,14.729Q19.941,13.176,19.837,11.498Q19.696,9.231,18.334,7.377Q16.996,5.556,14.921,4.714Q13.755,4.241,12.502,4.164Q10.824,4.059,9.271,4.635Q7.778,5.189,6.613,6.287Q5.452,7.382,4.811,8.837Q4.148,10.341,4.148,12Q4.148,14.08,5.299,15.981Q6.025,17.179,5.451,18.441L5.203,18.986L4.998,19.438Q4.919,19.611,4.998,19.724Q5.087,19.852,5.283,19.852L12,19.852ZM15.779,10.51L8.22,10.5L8.22,10.5C7.898,10.499,7.624,10.27,7.566,9.955C7.558,9.915,7.555,9.875,7.555,9.835L7.555,9.835C7.555,9.513,7.784,9.238,8.1,9.181C8.139,9.173,8.18,9.17,8.22,9.17L8.22,9.17L15.78,9.18L15.78,9.18C15.957,9.18,16.126,9.251,16.251,9.376C16.367,9.493,16.436,9.649,16.444,9.814C16.444,9.814,16.445,9.845,16.445,9.845L16.445,9.845C16.444,10.167,16.215,10.441,15.9,10.499C15.86,10.507,15.82,10.51,15.78,10.51L15.779,10.51ZM12,14.825L8.22,14.825C7.853,14.825,7.555,14.527,7.555,14.16C7.555,13.793,7.853,13.495,8.22,13.495L12,13.495C12.367,13.495,12.665,13.793,12.665,14.16C12.665,14.527,12.367,14.825,12,14.825Z"/>',
  more: '<g transform="matrix(0.707,0.707,-0.707,0.707,5.517,-3.928)"><path fill="currentColor" fill-rule="evenodd" d="M16.5,14.361L16.5,6.026L8.165,6.026C7.798,6.026,7.5,5.728,7.5,5.361C7.5,4.993,7.798,4.696,8.165,4.696L17.165,4.696C17.532,4.696,17.83,4.993,17.83,5.361L17.83,14.361C17.83,14.728,17.532,15.026,17.165,15.026C16.798,15.026,16.5,14.728,16.5,14.361Z"/></g>',
  edit: '<path fill="currentColor" fill-rule="evenodd" d="M12.276,5.165L8.478,5.165Q7.029,5.165,6.401,5.501Q5.815,5.815,5.501,6.401Q5.165,7.029,5.165,8.478L5.165,15.522Q5.165,16.971,5.501,17.599Q5.815,18.185,6.401,18.499Q7.029,18.835,8.478,18.835L15.522,18.835Q16.971,18.835,17.599,18.499Q18.185,18.185,18.499,17.599Q18.835,16.971,18.835,15.522L18.835,11.751C18.835,11.383,19.133,11.086,19.5,11.086C19.867,11.086,20.165,11.383,20.165,11.751L20.165,15.522Q20.165,17.304,19.672,18.226Q19.168,19.168,18.226,19.672Q17.304,20.165,15.522,20.165L8.478,20.165Q6.696,20.165,5.774,19.672Q4.832,19.168,4.328,18.226Q3.835,17.304,3.835,15.522L3.835,8.478Q3.835,6.696,4.328,5.774Q4.832,4.832,5.774,4.328Q6.696,3.835,8.478,3.835L12.276,3.835C12.317,3.835,12.357,3.839,12.397,3.846C12.712,3.904,12.941,4.179,12.941,4.5C12.941,4.821,12.712,5.096,12.397,5.154C12.357,5.161,12.317,5.165,12.276,5.165ZM14.511,6.549L11.894,9.166Q11.359,9.701,11.183,10.438L10.979,11.287L10.878,11.713Q10.712,12.407,11.213,12.909Q11.723,13.42,12.421,13.235L12.883,13.113L13.796,12.871Q14.479,12.69,14.987,12.184L17.599,9.579L19.518,7.664Q20.152,7.032,20.161,6.135Q20.17,5.23,19.539,4.599Q18.904,3.964,17.987,3.972Q17.08,3.98,16.447,4.613L14.511,6.549ZM18.12,7.18L16.941,6L17.388,5.553Q17.636,5.305,17.999,5.302Q18.358,5.299,18.599,5.539Q18.835,5.775,18.831,6.122Q18.827,6.475,18.579,6.722L18.12,7.18ZM12.476,10.747Q12.565,10.375,12.834,10.106L15.451,7.489L16,6.94L17.179,8.119L16.66,8.637L14.047,11.242Q13.793,11.496,13.455,11.585L12.543,11.827L12.196,11.919L12.273,11.597L12.476,10.747Z"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">${ICON[name]}</svg>`;
const LINK_ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true"><path d="M10.6 13.4a3.5 3.5 0 0 0 4.95 0l3.54-3.54a3.5 3.5 0 0 0-4.95-4.95l-1.06 1.06M13.4 10.6a3.5 3.5 0 0 0-4.95 0l-3.54 3.54a3.5 3.5 0 0 0 4.95 4.95l1.06-1.06" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
// NCM's share sheet: 云音乐笔记 (SHARE_PLATPORM_TYEP.events) and 私信 (.messages)
const SHARE_TO = [
  { platform: 0, text: '云音乐笔记', icon: '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><circle cx="14" cy="14" r="14" fill="#ff3a3a"/><path d="M12.2 8.6v7.1a2.6 2.6 0 1 0 1.5 2.4v-6.6l4.6-1.3V8.1z" fill="#fff"/></svg>' },
  { platform: 1, text: '私信', icon: '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><circle cx="14" cy="14" r="14" fill="#ff3a3a"/><path d="M8 10.2C8 9 9 8 10.2 8h7.6C19 8 20 9 20 10.2v5.4c0 1.2-1 2.2-2.2 2.2h-4.3L10.6 20v-2.2h-.4C9 17.8 8 16.8 8 15.6z" fill="#fff"/></svg>' },
];

// VIP badges (module 627 / 82): NCM's vipIconInfo / svipIconInfo, state "normal", v0..v7, 16px tall.
const D = 'https://d1.music.126.net/dmusic/obj/w5zCg8OAw6HDjzjDgMK_/';
const D2 = 'https://d2.music.126.net/dmusic/obj/w5zCg8OAw6HDjzjDgMK_/';
const VIP = [
  `${D}32582604543/b051/3fe1/c9c3/e4101426ba529ee5e4f74be23dbf2376.svg`,
  `${D}32582640318/830d/a8c8/b9f1/4ec851251ac3cb8f335a0c291157ebf8.svg`,
  `${D2}32582638536/30bd/ee55/5cc0/2e328526bdbbde1d53b652b70d10938c.svg`,
  `${D}32582635822/5438/366d/7848/9abf3b92070d4b015f49d6a09dfd4173.svg`,
  `${D}32582637724/cc23/3e8e/cc91/c90fb769d6c734389006fb35e07f8662.svg`,
  `${D}32582637725/0ee7/d773/7604/c4533aefa984c32d7207774175ce33a5.svg`,
  `${D2}32582638538/d867/961f/0e92/49a8c3e1dcd20bfcafe6b20677b22e5e.svg`,
  `${D}32582640321/4106/b300/f8df/1ef73454d0e3ce82b83cc20f161bc125.svg`,
];
const SVIP = [
  `${D}32582764823/4f10/94f9/2b9a/98ffb838cdd95e2afedb691c62183500.svg`,
  `${D}32582765877/d8fb/f3cc/0980/6d6119ca09b87159ac4d834c20c4a538.svg`,
  `${D}32582768209/f043/ad22/f6b4/cb87a8198bc925b09030b3c7987ed655.svg`,
  `${D}32582766631/eead/169c/3e4b/e0d83d3256967d8b6067f0e5fe6262e5.svg`,
  `${D}32582764824/2022/1f81/b8d2/99dcde229a5dcc67cbd1fe68670327cf.svg`,
  `${D}32582768210/b555/ac08/da47/03b08f266bfc45069c53d48977f6a9af.svg`,
  `${D}32582764825/b0c4/ed24/1c83/0ce7e6e38570927666bb8061354139b7.svg`,
  `${D}32582767244/b59a/2509/2fc2/59ba5e50284ad5f285952a702f2d578a.svg`,
];

// [词] emoji (module 466); any other bracketed word stays text.
const EMOJI = {
  大笑: 86, 可爱: 85, 憨笑: 359, 色: 95, 亲亲: 363, 惊恐: 96, 流泪: 356, 亲: 362, 呆: 352, 哀伤: 342, 呲牙: 343, 吐舌: 348,
  撇嘴: 353, 怒: 361, 奸笑: 341, 汗: 97, 痛苦: 346, 惶恐: 354, 生病: 350, 口罩: 351, 大哭: 357, 晕: 355, 发怒: 115, 开心: 360,
  鬼脸: 94, 皱眉: 87, 流感: 358, 爱心: 33, 心碎: 34, 钟情: 303, 星星: 309, 生气: 314, 便便: 89, 强: 13, 弱: 372, 拜: 14,
  牵手: 379, 跳舞: 380, 禁止: 374, 这边: 262, 爱意: 106, 示爱: 376, 嘴唇: 367, 狗: 81, 猫: 78, 猪: 100, 兔子: 459, 小鸡: 450,
  公鸡: 461, 幽灵: 116, 圣诞: 411, 外星: 101, 钻石: 52, 礼物: 107, 男孩: 0, 女孩: 1, 蛋糕: 337, 18: 186, 圈: 312, 叉: 313,
};
const emojiPath = (id) => `assets/img/common/emt/2x/emoji_${id}_20.webp`;
const EMPTY_PIC = () => `assets/img/empty/cm_empty_wupinglun${state.scheme === 'light' ? '' : '@dark'}.png`;

// RichParagraph's tokens: @mention (group 2), web link (group 4), #topic# (group 9).
const ACT = /(@([一-龥A-Za-z0-9-_]{2,})((?=[ :@：])|$))|((http[s]{0,1}):\/\/[\-a-zA-Z0-9\.]+(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9][0-9]|6[0-4][0-9][0-9][0-9]|\\d{2,4}|[1-9]))?(\/[a-zA-Z0-9\\\.\-~!@#$%\^&\*\+\?:_\/=<>]*)?)|(#[^\[\]\/\\\#\r\n]+?#)/g;

// --- panel state ----------------------------------------------------------------------------
let root = null;
let scroller = null;
let publishBtn = null;
let pop = null; // the share sheet
let toastEl = null;
let shown = false;
let thread = ''; // the thread on screen (or loading)
let status = 'idle'; // idle | loading | ready | error
let gen = 0; // bumps when the list is reset; answers for an older list are dropped
let timer = 0;
let total = 0;
let offset = 0;
let more = false;
let moreHot = false;
let paging = false; // a next page is on its way (NCM's observer has no such guard)
let pageFailed = false;
const seen = new Set(); // comment ids in the lists: offset paging on a live thread repeats some
const byId = new Map(); // id -> slim comment, for the card's buttons
let observer = null;
let sentinel = null;
let hotList = null;
let latestList = null;
const assets = new Map(); // asset path -> data URL ('' when it failed)
const assetWait = new Set();

// --- data ----------------------------------------------------------------------------------
const httpsUrl = (u) => String(u || '').replace(/^http:\/\//, 'https://');
const sized = (u, px) => (u ? `${httpsUrl(u).replace(/\?.*$/, '')}?param=${px}y${px}` : '');

/** The parts of an API comment the card shows (NCM's module 21 keeps a similar whitelist). */
function slim(c) {
  const u = c.user || {};
  const v = u.vipRights || null;
  return {
    id: String(c.commentId ?? c.id ?? ''),
    status: c.status || 0,
    content: c.content || '',
    richContent: c.richContent || '',
    time: c.time || 0,
    timeStr: c.timeStr || '',
    likedCount: Number(c.likedCount) || 0,
    liked: !!c.liked,
    pendant: c.pendantData?.imageUrl || '',
    user: {
      id: String(u.userId ?? u.id ?? ''),
      nickname: u.nickname || u.nickName || u.userName || '',
      avatarUrl: u.avatarUrl || '',
      identity: u.avatarDetail?.identityIconUrl || '',
      badge: badgeOf(v),
    },
    replied: (c.beReplied || []).map((r) => ({
      nickname: r.user?.nickname || '',
      text: textOf(r.richContent, r.content, r.status),
    })),
  };
}

/** CommentUserVipTag: SVIP, else 黑胶VIP, else 音乐包. */
function badgeOf(v) {
  if (!v) return null;
  const level = Number(v.redVipLevel) || 0;
  const n = level >= 1 && level <= 7 ? level : 0;
  if (v.redplus?.rights) return { src: SVIP[n], w: n ? 52 : 40 };
  if (v.associator?.rights) return { src: VIP[n], w: n ? 48 : 36 };
  if (v.musicPackage?.rights && v.musicPackage.iconUrl) return { src: httpsUrl(v.musicPackage.iconUrl), w: 0 };
  return null;
}

/** CommentCard's getCommentText + RichParagraph's clean-up. */
function textOf(rich, plain, status) {
  let t = rich || plain || (status === -10 ? '该评论涉及违规内容，经举报已被屏蔽' : '该评论已删除');
  t = t.replace(/<song\s+id="[^"]*">([^<]*)<\/song>/g, '$1 ');
  t = t.replace(/<c0m_cvt[\s\S]+?j="([^"]+)"[^>]+>/g, (_, j) => {
    try { return JSON.parse(decodeURIComponent(j)).text || ''; } catch { return '[表情]'; }
  });
  return t.trim()
    .replace(/([̀-ͯ]|[ิ-฾]|[็-๎]|ั){2,}/g, '$1')
    .replace(/[҈҉]+/g, '')
    .replace(/([ \f\r\t\v]*\n){2,}/g, '\n\n');
}

/** module 32's formatNumberWtihUnit; 0 shows nothing. */
function count(n) {
  if (!(n > 0)) return '';
  if (n > 1e8) return `${Math.floor(n / 1e7) / 10}亿`;
  if (n > 1e5) return `${Math.floor(n / 1e3) / 10}万`;
  return String(Math.floor(n));
}

// --- DOM helpers ---------------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function img(cls, src, w, h) {
  const i = el('img', cls);
  i.alt = '';
  i.decoding = 'async';
  i.loading = 'lazy';
  if (w) i.width = w;
  if (h) i.height = h;
  i.src = src;
  // a broken remote image leaves only its placeholder
  i.addEventListener('error', () => { i.style.visibility = 'hidden'; }, { once: true });
  return i;
}

/** Text with [emoji] images (module 466 c()). */
function appendEmojiText(parent, text) {
  let last = 0;
  for (const m of text.matchAll(/\[(.*?)\]/g)) {
    const id = EMOJI[m[1]];
    if (id == null) continue;
    if (m.index > last) parent.append(text.slice(last, m.index));
    const e = el('img', 'bncm-cm-emoji');
    e.alt = m[0];
    e.width = 20;
    e.height = 20;
    e.dataset.asset = emojiPath(id);
    parent.append(e);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** RichParagraph: mentions, web links and topics become links, the rest is text with emoji. */
function rich(parent, text) {
  let last = 0;
  ACT.lastIndex = 0;
  for (let m; (m = ACT.exec(text));) {
    let a = null;
    if (m[1]) {
      // a mention is a link only when 4..32 wide, CJK counting double
      const w = m[2].replace(/[^\x00-\xff]/g, '**').length;
      if (w < 4 || w > 32) continue;
      a = el('a', 'bncm-cm-at', `@${m[2]}`);
      a.dataset.act = 'at';
      a.dataset.name = m[2];
    } else if (m[4]) {
      a = el('a', 'bncm-cm-url');
      a.innerHTML = LINK_ICON;
      a.append('网页链接');
      a.dataset.act = 'url';
      a.dataset.url = m[4];
      a.title = m[4];
    } else {
      a = el('a', 'bncm-cm-topic', m[9]);
      a.dataset.act = 'topic';
      a.dataset.topic = m[9];
    }
    if (m.index > last) appendEmojiText(parent, text.slice(last, m.index));
    parent.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) appendEmojiText(parent, text.slice(last));
  return parent;
}

function card(c) {
  const node = el('div', 'bncm-cm-card');
  node.dataset.id = c.id;

  const av = el('div', 'bncm-cm-avatar');
  av.dataset.act = 'user';
  av.append(img('img', sized(c.user.avatarUrl, 80), 40, 40), el('div', 'border'));
  if (c.pendant) av.append(img('pendant', sized(c.pendant, 120), 60, 60));
  if (c.user.identity) av.append(img('identity', httpsUrl(c.user.identity)));

  const body = el('div', 'bncm-cm-body');
  const nick = el('div', 'bncm-cm-nick');
  const name = el('span', 'name', c.user.nickname);
  name.dataset.act = 'user';
  nick.append(name);
  if (c.user.badge) {
    const b = img('badge', c.user.badge.src, c.user.badge.w || undefined, 16);
    if (!c.user.badge.w) b.classList.add('auto');
    nick.append(b);
  }
  body.append(nick, rich(el('span', 'bncm-cm-text selectable'), textOf(c.richContent, c.content, c.status)));
  if (c.replied.length) {
    const q = el('div', 'bncm-cm-replied selectable');
    for (const r of c.replied) q.append(rich(el('span'), `@${r.nickname}: ${r.text}`));
    body.append(q);
  }

  const foot = el('div', 'bncm-cm-foot');
  const ops = el('div', 'bncm-cm-ops');
  const like = el('div', 'bncm-cm-like');
  like.append(el('span', 'num'), iconButton('like', '赞'));
  const share = iconButton('share', '分享');
  const reply = iconButton('reply', '回复');
  share.classList.add('last');
  reply.classList.add('last');
  ops.append(like, share, reply);
  foot.append(el('span', 'bncm-cm-time', c.timeStr), ops);
  body.append(foot);

  node.append(av, body);
  paintLike(node, c);
  return node;
}

function iconButton(act, label) {
  const b = el('button', 'bncm-cm-icon');
  b.type = 'button';
  b.dataset.act = act;
  b.setAttribute('aria-label', label);
  if (act !== 'like') b.innerHTML = svg(act);
  return b;
}

function paintLike(node, c) {
  const num = node.querySelector('.bncm-cm-like .num');
  const btn = node.querySelector('.bncm-cm-icon[data-act="like"]');
  num.textContent = count(c.likedCount);
  num.classList.toggle('liked', c.liked);
  btn.classList.toggle('liked', c.liked);
  btn.innerHTML = svg(c.liked ? 'liked' : 'praise');
}

function header(text, n) {
  const h = el('div', 'bncm-cm-head', text);
  const sup = el('span', 'num', n > 0 ? String(n) : '');
  h.append(sup);
  return h;
}

function setCounts() {
  for (const s of scroller.querySelectorAll('.bncm-cm-head .num')) s.textContent = total > 0 ? String(total) : '';
}

// --- assets from NCM's page (emoji, empty picture) ----------------------------------------------
function fillAssets(scope) {
  const want = [];
  for (const e of scope.querySelectorAll('img[data-asset]')) {
    const p = e.dataset.asset;
    if (assets.has(p)) applyAsset(e, assets.get(p));
    else if (!assetWait.has(p)) { assetWait.add(p); want.push(p); }
  }
  if (!want.length) return;
  request('ncmAction', { action: 'commentAssets', paths: want }).then((got) => {
    for (const p of want) assets.set(p, got?.[p] || '');
  }, () => {
    for (const p of want) assets.set(p, '');
  }).then(() => {
    for (const p of want) assetWait.delete(p);
    if (!root) return;
    for (const e of root.querySelectorAll('img[data-asset]')) if (assets.has(e.dataset.asset)) applyAsset(e, assets.get(e.dataset.asset));
  });
}

function applyAsset(e, url) {
  delete e.dataset.asset;
  if (url) e.src = url;
  else if (e.classList.contains('bncm-cm-emoji')) e.replaceWith(e.alt); // NCM could not give it: show the word
  else e.remove();
}

// --- states ----------------------------------------------------------------------------------------
function reset() {
  gen++;
  clearTimeout(timer);
  closeShare();
  observer?.disconnect();
  sentinel = null;
  hotList = null;
  latestList = null;
  seen.clear();
  byId.clear();
  total = 0;
  offset = 0;
  more = false;
  moreHot = false;
  paging = false;
  pageFailed = false;
  scroller.textContent = '';
  scroller.scrollTop = 0;
}

function showSkeleton() {
  scroller.append(header('全部评论', 0));
  const ul = el('ul', 'bncm-cm-skeleton');
  const rows = Math.max(1, Math.ceil((innerHeight - 145) / 80));
  for (let i = 0; i < rows; i++) {
    const li = el('li');
    const right = el('div', 'right');
    right.append(el('div', 'msg sk'), el('div', 'time sk'));
    li.append(el('div', 'left sk'), right);
    ul.append(li);
  }
  scroller.append(ul);
}

function showNoThread() {
  reset();
  status = 'ready';
  root.classList.add('no-thread');
  const box = el('div', 'bncm-cm-empty');
  box.append(el('div', 'desc', '暂时无法评论非线上歌曲'));
  scroller.append(box);
}

function showEmpty() {
  const box = el('div', 'bncm-cm-empty');
  const pic = el('img', 'pic');
  pic.alt = '';
  pic.width = 180;
  pic.height = 180;
  pic.dataset.asset = EMPTY_PIC();
  box.append(pic, el('div', 'title', '等评论...'), el('div', 'desc', '没人来撩一下我吗？'));
  scroller.append(box);
  fillAssets(box);
}

function showError() {
  const box = el('div', 'bncm-cm-error');
  const retry = el('button', 'bncm-cm-retry', '重试');
  retry.type = 'button';
  retry.dataset.act = 'retry';
  box.append(el('div', 'desc', '获取评论数据失败, 请稍后再试'), retry);
  scroller.append(box);
}

function showLists(hot, latest) {
  const wrap = el('div', 'bncm-cm-lists');
  if (hot.length) {
    hotList = el('div', 'bncm-cm-list');
    for (const c of hot) hotList.append(card(c));
    const moreBox = el('div', 'bncm-cm-more');
    if (moreHot) {
      const b = el('button', 'bncm-cm-more-btn', '查看更多精彩评论');
      b.type = 'button';
      b.dataset.act = 'moreHot';
      b.insertAdjacentHTML('beforeend', svg('more'));
      moreBox.append(b);
    }
    wrap.append(hotList, moreBox, header('最新评论', total));
  }
  latestList = el('div', 'bncm-cm-list');
  appendLatest(latest);
  wrap.append(latestList);
  scroller.append(wrap);
  updateSentinel();
}

function appendLatest(list) {
  const frag = document.createDocumentFragment();
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    byId.set(c.id, c);
    frag.append(card(c));
  }
  latestList.append(frag);
  fillAssets(latestList);
}

// --- loading ----------------------------------------------------------------------------------------
async function loadFirst() {
  const g = gen;
  const tid = thread;
  status = 'loading';
  let j;
  try {
    j = await ncmFetch(API(tid, 0));
    if (!j || typeof j !== 'object' || j.code !== 200) throw new Error(`code ${j?.code}`);
  } catch (e) {
    if (g !== gen) return;
    log('comments failed:', tid, String(e?.message || e));
    status = 'error';
    scroller.textContent = '';
    scroller.append(header('全部评论', 0));
    showError();
    return;
  }
  if (g !== gen) return;
  status = 'ready';
  total = Number(j.total) || 0;
  more = !!j.more;
  moreHot = !!j.moreHot;
  const comments = j.comments || [];
  offset = comments.length;
  const hot = (j.hotComments || []).slice(0, HOT_SHOWN).map(slim);
  const latest = comments.map(slim);
  scroller.textContent = '';
  scroller.append(header('全部评论', total));
  if (total <= 0 && !hot.length && !latest.length) { showEmpty(); return; }
  for (const c of hot) byId.set(c.id, c); // hot ids may come back among the latest; they show in both, as in NCM
  showLists(hot, latest);
  if (hotList) fillAssets(hotList);
}

async function loadMore() {
  if (paging || !more || pageFailed || status !== 'ready' || !latestList) return;
  paging = true;
  const g = gen;
  const tid = thread;
  updateSentinel();
  try {
    const j = await ncmFetch(API(tid, offset));
    if (g !== gen) return;
    if (!j || typeof j !== 'object' || j.code !== 200) throw new Error(`code ${j?.code}`);
    const comments = j.comments || [];
    offset += comments.length;
    more = !!j.more && comments.length > 0;
    appendLatest(comments.map(slim));
  } catch (e) {
    if (g !== gen) return;
    log('comments page failed:', tid, offset, String(e?.message || e));
    pageFailed = true;
  } finally {
    if (g === gen) { paging = false; updateSentinel(); }
  }
}

/** The spinner (or a retry) after the latest list while there are more pages. */
function updateSentinel() {
  if (!more) {
    observer?.disconnect();
    sentinel?.remove();
    sentinel = null;
    return;
  }
  if (!sentinel) {
    sentinel = el('div', 'bncm-cm-sentinel');
    scroller.querySelector('.bncm-cm-lists')?.append(sentinel);
  }
  sentinel.textContent = '';
  sentinel.removeAttribute('data-act');
  if (pageFailed) {
    sentinel.textContent = '加载失败，点击重试';
    sentinel.dataset.act = 'retryMore';
  } else if (paging) {
    sentinel.append(el('span', 'bncm-cm-spin'));
  }
  // observe afresh so a sentinel that is still in range after a page triggers the next one
  observer?.disconnect();
  if (!paging && !pageFailed) observer?.observe(sentinel);
}

function startLoad(delay) {
  clearTimeout(timer);
  reset();
  status = 'loading';
  showSkeleton();
  timer = setTimeout(() => { timer = 0; loadFirst(); }, delay);
}

// --- actions -------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('shown'), 2000);
}

/** An action that shows NCM's window (a dialog, a page): collapse, then ask NCM. */
function inNcm(fields, timeout) {
  closeShare();
  collapse();
  return request('ncmAction', fields, timeout).catch((e) => { log('comment action failed:', fields.action, String(e?.message || e)); return null; });
}

const liking = new Set(); // comment ids with a like on its way: a second click would race the revert
async function toggleLike(node) {
  const c = byId.get(node.dataset.id);
  if (!c || liking.has(c.id)) return;
  liking.add(c.id);
  try { await likeOnce(c); } finally { liking.delete(c.id); }
}

async function likeOnce(c) {
  const like = !c.liked;
  const tid = thread;
  // NCM's card updates at once and never hears back from the server
  c.liked = like;
  c.likedCount = Math.max(0, c.likedCount + (like ? 1 : -1));
  repaintComment(c);
  let res = null;
  try {
    res = await request('ncmAction', { action: 'commentLike', threadId: tid, commentId: c.id, like });
  } catch (e) {
    log('comment like failed:', String(e?.message || e));
  }
  if (res?.ok) return;
  c.liked = !like;
  c.likedCount = Math.max(0, c.likedCount + (like ? -1 : 1));
  repaintComment(c);
  if (res?.anonymous) inNcm({ action: 'commentLogin' });
  else toast(like ? '点赞失败, 请稍后重试' : '取消点赞失败, 请稍后重试');
}

/** A comment can be in both lists (a hot one that is also recent). */
function repaintComment(c) {
  for (const n of scroller.querySelectorAll('.bncm-cm-card')) if (n.dataset.id === c.id) paintLike(n, c);
}

async function publish(reply) {
  const tid = thread;
  const g = gen;
  const fields = { action: 'commentPublish', threadId: tid, title: state.track?.title || '' };
  if (reply) fields.reply = { id: reply.id, user: { id: reply.user.id, nickname: reply.user.nickname, avatarUrl: reply.user.avatarUrl } };
  const raw = await inNcm(fields, MODAL_TIMEOUT);
  if (!raw || g !== gen || tid !== thread || status !== 'ready') return;
  // as NCM: the new comment goes to the top of the latest list and the count goes up
  const c = slim(raw);
  if (!c.timeStr) c.timeStr = '刚刚';
  total += 1;
  if (!latestList) {
    scroller.textContent = '';
    scroller.append(header('全部评论', total));
    showLists([], []);
  }
  seen.add(c.id);
  byId.set(c.id, c);
  latestList.prepend(card(c));
  fillAssets(latestList.firstChild);
  setCounts();
}

function shareComment(c, platform) {
  inNcm({
    action: 'commentShare', threadId: thread, platform,
    comment: {
      id: c.id, threadId: thread, content: c.content, richContent: c.richContent, status: c.status, time: c.time, timeStr: c.timeStr,
      likedCount: c.likedCount, liked: c.liked, user: { id: c.user.id, nickname: c.user.nickname, avatarUrl: c.user.avatarUrl },
    },
  });
}

function openShare(btn, c) {
  if (pop.dataset.id === c.id && pop.classList.contains('shown')) { closeShare(); return; }
  pop.dataset.id = c.id;
  const pr = root.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const w = 178;
  const left = Math.min(pr.width - w, Math.max(0, br.left + br.width / 2 - w / 2 - pr.left));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${pr.bottom - br.top + 6}px`;
  pop.classList.add('shown');
}

function closeShare() {
  pop?.classList.remove('shown');
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-act]') : null;
  if (!t || !root.contains(t)) return;
  const act = t.dataset.act;
  const node = t.closest('.bncm-cm-card');
  const c = node ? byId.get(node.dataset.id) : null;
  e.preventDefault();
  switch (act) {
    case 'like': if (node) toggleLike(node); break;
    case 'reply': if (c) publish(c); break;
    case 'share': if (c) openShare(t, c); break;
    case 'shareTo': {
      const target = byId.get(pop.dataset.id);
      closeShare();
      if (target) shareComment(target, Number(t.dataset.platform));
      break;
    }
    case 'user': if (c?.user.id) inNcm({ action: 'commentLink', path: `/userDetail/user/${c.user.id}` }); break;
    case 'at': inNcm({ action: 'commentLink', path: `/userDetail/nickname/${t.dataset.name}` }); break;
    case 'topic': inNcm({ action: 'commentLink', path: `/community/topic/${encodeURIComponent(t.dataset.topic)}` }); break;
    case 'url': request('ncmAction', { action: 'commentOpenUrl', url: t.dataset.url }).catch(() => {}); break;
    case 'moreHot': if (thread) inNcm({ action: 'commentLink', path: `/hotComments/${thread}` }); break;
    case 'publish': if (thread) publish(null); break;
    case 'retry': startLoad(0); break;
    case 'retryMore': pageFailed = false; updateSentinel(); break;
    default: break;
  }
}

// --- panel -------------------------------------------------------------------------------------------
function mount(el0) {
  root = el0;
  scroller = el('div', 'bncm-scroll bncm-cm-scroll');
  const pub = el('div', 'bncm-cm-publish');
  publishBtn = el('button', 'bncm-cm-publish-btn');
  publishBtn.type = 'button';
  publishBtn.dataset.act = 'publish';
  publishBtn.innerHTML = `<span class="icon">${svg('edit')}</span><span>发布评论</span>`;
  pub.append(publishBtn);
  pop = el('div', 'bncm-cm-share');
  for (const s of SHARE_TO) {
    const row = el('div', 'bncm-cm-share-row');
    row.dataset.act = 'shareTo';
    row.dataset.platform = String(s.platform);
    row.innerHTML = s.icon;
    row.append(el('span', 'text', s.text));
    pop.append(row);
  }
  toastEl = el('div', 'bncm-cm-toast');
  root.append(scroller, pub, pop, toastEl);
  root.addEventListener('click', onClick);
  scroller.addEventListener('scroll', closeShare, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (pop.classList.contains('shown') && !(e.target instanceof Element && e.target.closest('.bncm-cm-share, .bncm-cm-icon[data-act="share"]'))) closeShare();
  }, true);
  document.addEventListener('bncm-escape', (e) => {
    if (pop.classList.contains('shown')) { closeShare(); e.preventDefault(); }
  });
  observer = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting)) loadMore();
  }, { root: scroller, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` });
}

function show(track) {
  const tid = track?.threadId || '';
  const wasShown = shown;
  shown = true;
  if (!tid) {
    if (!root.classList.contains('no-thread')) { thread = ''; showNoThread(); }
    return;
  }
  root.classList.remove('no-thread');
  if (tid === thread && status !== 'error' && status !== 'idle') return; // same thread: keep the list and where it was scrolled to
  thread = tid;
  // a track change while the panel shows waits as NCM does, so a run of skips loads once
  startLoad(wasShown ? SKIP_MS : 0);
}

function hide() {
  shown = false;
  closeShare();
  if (timer) {
    // nothing was asked yet: start over when the panel shows again
    clearTimeout(timer);
    timer = 0;
    status = 'idle';
  }
}

registerPanel('comment', { mount, show, hide });
