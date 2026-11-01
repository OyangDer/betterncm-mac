// Builds the document-start script registered with Page.addScriptToEvaluateOnNewDocument (DESIGN.md 1.3).
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.mjs';
import { log } from './log.mjs';

// Prelude files in the frame sections they belong to. Any other src/prelude/*.js
// runs in the top frame right before the framework, in name order.
const ORPHEUS_FRAMES = ['polyfills.js', 'native-shim.js', 'hijack-runtime.js', 'devtools-key.js'];
const TOP_FRAME = ['channel-shim.js'];
// Extras that change the look rather than fix something, each behind a config key that must be
// 'true': Apple Music-style RefinedNowPlayingNext layout and cover motion, a still mini vinyl,
// lyrics sized to the window.
const OPTIONAL_PRELUDE = {
  'compat-rnp-layout.js': 'mac.rnpAppleStyle',
  'compat-rnp-cover.js': 'mac.rnpAppleStyle',
  'compat-rnp-top-controls.js': 'mac.rnpAppleStyle',
  'compat-rnp-menu-style.js': 'mac.rnpAppleStyle',
  'compat-rnp-panels.js': 'mac.rnpAppleStyle',
  'compat-rnp-lyric-switch.js': 'mac.rnpAppleStyle',
  'stop-mini-vinyl.js': 'mac.stopMiniVinyl',
  'compat-rnp-lyric-size.js': 'mac.rnpAutoLyricSize',
  'hide-plugin-manager.js': '!mac.pluginManager', // "!": runs unless the key is 'true'
  'lyrics-bridge.js': 'mac.lyricsWindow',
};
// The bridge's action files (lyrics-actions-*.js) go with it.
const LYRICS_PRELUDE = /^lyrics-/;
// The lyrics window replaces RefinedNowPlayingNext, so everything made for RNPN's page stays out
// while it is on.
const RNP_PRELUDE = /^compat-rnp-/;

function keyHolds(key, cfg) {
  return key.startsWith('!') ? cfg[key.slice(1)] !== 'true' : cfg[key] === 'true';
}

function preludeWanted(name, cfg) {
  if (RNP_PRELUDE.test(name) && cfg['mac.lyricsWindow'] === 'true') return false;
  if (LYRICS_PRELUDE.test(name) && cfg['mac.lyricsWindow'] !== 'true') return false;
  const key = OPTIONAL_PRELUDE[name];
  return !key || keyHolds(key, cfg);
}

const missingWarned = new Set();

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    if (!missingWarned.has(file)) {
      missingWarned.add(file);
      log('bundle: missing', file);
    }
    return null;
  }
}

// Each prelude part gets its own function scope, so one failing part does not stop the rest.
// A part that does not even parse is left out, because it would break the whole script.
function wrapPart(name, code) {
  try {
    new Function(code); // parse check only, nothing runs
  } catch (e) {
    log(`bundle: prelude ${name} has a syntax error, skipped:`, e.message);
    return `console.error(${JSON.stringify(`[BetterNCM] prelude ${name} skipped: ${e.message}`)});\n`;
  }
  return `;(function(){try{\n${code}\n}catch(e){console.error('[BetterNCM] prelude ${name} failed',e)}})();\n`;
}

// Run as a separate global-scope eval, so that a syntax error stays contained and the code
// keeps its own sourceURL and inline source map. Top-level var/function become globals, but
// const/let/class stay local to the eval: fine for the framework bundle, not for startup scripts.
function evalPart(label, code, sourceURL) {
  const src = JSON.stringify(`${code}\n//# sourceURL=${sourceURL}`);
  return `try{(0,eval)(${src})}catch(e){console.error(${JSON.stringify(`[BetterNCM] ${label} failed`)},e)}\n`;
}

// Startup scripts run as classic <script> elements, like a v2 executeJavaScript call: their
// top-level const/let/class become global lexical bindings that later scripts can see.
// An error stays in that one element; a temporary error listener puts the label on it.
// Without a DOM (unit tests) this falls back to indirect eval.
const RUN_SCRIPT_HELPER = `const __bncmRunScript=(code,label)=>{`
  + `const report=(e)=>console.error('[BetterNCM] '+label+' failed',e);`
  + `if(typeof document==='undefined'||!document.createElement){try{(0,eval)(code)}catch(e){report(e)}return}`
  + `const onError=(ev)=>report(ev.error??ev.message);`
  + `window.addEventListener('error',onError);`
  + `try{const s=document.createElement('script');s.text=code;(document.documentElement||document).appendChild(s);s.remove()}`
  + `catch(e){report(e)}finally{window.removeEventListener('error',onError)}};\n`;

function scriptPart(label, code, sourceURL) {
  return `__bncmRunScript(${JSON.stringify(`${code}\n//# sourceURL=${sourceURL}`)},${JSON.stringify(label)});\n`;
}

export function buildInjection({ targetId, apiKey, apiPort, safe = false, cfg = {}, hijacks = [], startupScripts = [], root = PROJECT_ROOT }) {
  const preludeDir = path.join(root, 'src/prelude');
  const prelude = (name) => readOptional(path.join(preludeDir, name));
  let extras = [];
  try {
    extras = fs.readdirSync(preludeDir)
      .filter((f) => f.endsWith('.js') && !ORPHEUS_FRAMES.includes(f) && !TOP_FRAME.includes(f))
      .sort();
  } catch { /* no prelude dir yet */ }

  const apiPath = `http://127.0.0.1:${apiPort}/api`;
  const filesPath = `http://127.0.0.1:${apiPort}/local`;
  const j = JSON.stringify;

  const out = [];

  // 1. Lexical globals, top level and unconditional (v2 App.cpp:569-585). The registration stays
  // on a target across navigations, so the secrets only get values in orpheus documents.
  const o = `location.protocol==='orpheus:'`;
  out.push(
    `const BETTERNCM_API_KEY=${o}?${j(String(apiKey))}:'', BETTERNCM_API_PORT=${o}?${Number(apiPort)}:0, `
    + `BETTERNCM_API_PATH=${o}?${j(apiPath)}:'', BETTERNCM_FILES_PATH=${o}?${j(filesPath)}:'';\n`,
    `const __BNCM_TARGET__=${j(String(targetId))}, __BNCM_HIJACKS__=${j(safe ? [] : hijacks)}, `
    + `__BNCM_SAFE__=${safe ? 'true' : 'false'}, __BNCM_CFG__=${j(cfg)};\n`,
  );

  // 2. Every orpheus frame: polyfills, native shim, hijack runtime, DevTools key.
  out.push(`if (location.protocol === 'orpheus:') {\n`);
  for (const name of ORPHEUS_FRAMES) {
    if (safe && name === 'hijack-runtime.js') continue;
    const code = prelude(name);
    if (code != null) out.push(wrapPart(name, code));
  }
  out.push('}\n');

  // 3. Top orpheus frame: channel shim, extras, framework, startup scripts.
  out.push(`if (window === top && location.protocol === 'orpheus:') {\n`);
  out.push(`console.log('BetterNCM API Initialized on', BETTERNCM_API_PORT);\n`);
  if (cfg['mac.channelShim'] === 'true') {
    const code = prelude('channel-shim.js');
    if (code != null) out.push(wrapPart('channel-shim.js', code));
  }
  for (const name of extras) {
    if (!preludeWanted(name, cfg)) continue;
    const code = prelude(name);
    if (code != null) out.push(wrapPart(name, code));
  }
  const fw = readOptional(path.join(root, 'dist/framework.js'));
  if (fw != null) out.push(evalPart('framework.js', fw, 'betterncm://betterncm/framework.js'));
  else out.push(`console.error('[BetterNCM] dist/framework.js is missing; run npm run build:fw');\n`);
  if (!safe) {
    const scripts = startupScripts.filter(({ code }) => typeof code === 'string' && code);
    if (scripts.length) out.push(RUN_SCRIPT_HELPER);
    for (const { slug, code } of scripts) {
      out.push(scriptPart(`startup script of ${slug}`, code, `file://${slug}/startup_script.js`));
    }
  }
  out.push('}\n');

  out.push('//# sourceURL=betterncm://betterncm/injection.js\n');
  return out.join('');
}
