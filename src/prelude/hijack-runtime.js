// Plugin hijacks (manifest.hijacks) for orpheus:// scripts, done in the page instead of in the
// CEF scheme handler as v2 does (DESIGN.md 4, "Hijack runtime"). CDP Fetch does not see
// orpheus:// loads (P1), so matching <script src> elements are fetched with a sync XHR,
// transformed and turned into inline scripts before they run:
//  - parser-inserted scripts: a MutationObserver installed at document start sees them before
//    the parser runs them (verified in M0);
//  - dynamic webpack chunks: appendChild/insertBefore wrappers, followed by a synthetic `load`.
// HTML targets (app.html) cannot be rewritten; their CSP actions are emulated by setBypassCSP.

// Pure transform, kept free of DOM access so test/hijack.test.mjs can run it in node.
// hijacks: [{slug, id, prefix, type, from, to, code}] as built by plugins.collectHijacks().
// Returns {text, applied: ['slug::id', ...]} where applied lists the actions that changed the text.
function __bncmTransform(text, url, hijacks) {
  const applied = [];
  for (const h of hijacks) {
    if (!h || typeof h.prefix !== 'string' || !url.startsWith(h.prefix)) continue;
    const before = text;
    try {
      if (h.type === 'regex') {
        // std::wregex (ECMAScript grammar) + regex_replace: global, same $1/$& replacement syntax.
        text = text.replace(new RegExp(h.from, 'g'), h.to);
      } else if (h.type === 'replace') {
        // Literal replace-all; split/join keeps `$` in the replacement literal.
        if (h.from) text = text.split(h.from).join(h.to);
      } else if (h.type === 'append') {
        // Chunks end with a `//# sourceMappingURL=` line and no newline; without the separator the
        // appended code would become part of that comment.
        text += (text.endsWith('\n') ? '' : '\n') + h.code;
      } else if (h.type === 'prepend') {
        text = h.code + text;
      }
    } catch (e) {
      console.warn('[BetterNCM] hijack ' + h.slug + '::' + h.id + ' failed on ' + url, e);
      text = before;
    }
    if (text !== before) applied.push(h.slug + '::' + h.id);
  }
  return { text, applied };
}

// Hijack entries that a <script> can never match: targets that are HTML pages.
function __bncmIsHtmlTarget(prefix) {
  return /\.html?(?:$|[?#])/.test(prefix);
}

function __bncmInstallHijacks() {
  if (typeof __BNCM_HIJACKS__ === 'undefined' || typeof document === 'undefined') return;
  if (typeof __BNCM_SAFE__ !== 'undefined' && __BNCM_SAFE__) return;

  const all = Array.isArray(__BNCM_HIJACKS__) ? __BNCM_HIJACKS__ : [];
  const scriptHijacks = all.filter((h) => h && typeof h.prefix === 'string' && !__bncmIsHtmlTarget(h.prefix));
  const state = { applied: [], rewritten: [], transform: __bncmTransform };
  window.__bncmHijack = state;

  const XHR = window.XMLHttpRequest;
  const fetchFn = window.fetch.bind(window);

  // Batched report to the API server (served back by /api/app/get_succeeded_hijacks).
  let pending = [];
  function report(ids) {
    if (!ids.length) return;
    state.applied.push(...ids);
    if (!pending.length) {
      setTimeout(() => {
        const body = JSON.stringify({ ids: pending });
        pending = [];
        fetchFn(BETTERNCM_API_PATH + '/internal/hijack_report', {
          method: 'POST',
          headers: {
            BETTERNCM_API_KEY,
            'X-BNCM-Target': __BNCM_TARGET__,
            'Content-Type': 'application/json',
          },
          body,
        }).catch((e) => console.warn('[BetterNCM] hijack report failed', e));
      });
    }
    pending.push(...ids);
  }

  // App.html actions: setBypassCSP stands in for the CSP edits that plugins such as AMLL make,
  // so those count as applied. Anything else on an HTML page cannot be emulated.
  const here = location.href;
  const cspIds = [];
  for (const h of all) {
    if (!h || typeof h.prefix !== 'string' || !__bncmIsHtmlTarget(h.prefix) || !here.startsWith(h.prefix)) continue;
    const bypassCSP = typeof __BNCM_CFG__ === 'undefined' || __BNCM_CFG__['mac.bypassCSP'] !== 'false';
    if (bypassCSP && h.type !== 'append' && h.type !== 'prepend'
      && /Content-Security-Policy|script-src/.test(String(h.from))) {
      cspIds.push(h.slug + '::' + h.id);
    } else {
      console.warn('[BetterNCM] hijack ' + h.slug + '::' + h.id + ' targets an HTML page; not supported on macOS');
    }
  }
  report(cspIds);

  if (!scriptHijacks.length) return;

  const matches = (url) => scriptHijacks.some((h) => url.startsWith(h.prefix));
  const seen = new WeakSet();

  function isClassicScript(el) {
    const t = (el.getAttribute('type') || '').trim().toLowerCase();
    return t === '' || t === 'text/javascript' || t === 'application/javascript';
  }

  // Turns a matching external script into an inline one with the transformed source.
  // Returns true when the element was rewritten.
  function rewrite(el) {
    if (seen.has(el)) return false;
    seen.add(el);
    const url = el.src;
    if (!url || !isClassicScript(el) || !matches(url)) return false;
    let source;
    try {
      const x = new XHR();
      x.open('GET', url, false);
      x.send();
      if (!(x.status === 200 || (x.status === 0 && x.responseText))) {
        console.warn('[BetterNCM] hijack: could not fetch ' + url + ' (HTTP ' + x.status + ')');
        return false;
      }
      source = x.responseText;
    } catch (e) {
      console.warn('[BetterNCM] hijack: could not fetch ' + url, e);
      return false;
    }
    const { text, applied } = __bncmTransform(source, url, scriptHijacks);
    // Nothing matched: leave the element alone so it loads exactly as before.
    if (!applied.length) return false;
    el.removeAttribute('src');
    el.text = text + '\n//# sourceURL=' + url;
    state.rewritten.push(url);
    report(applied);
    return true;
  }

  // Parser-inserted scripts (static <script src> in app.html and frames).
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeName === 'SCRIPT' && n.src) rewrite(n);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // Dynamic scripts (webpack's JSONP chunk loader uses document.head.appendChild).
  // An inline script runs during insertion, so webpackJsonp.push has installed the chunk by the
  // time the synthetic load event reaches the loader's onload handler.
  function wrapInsert(name) {
    const orig = Node.prototype[name];
    const wrapped = {
      [name](node, ...rest) {
        let inlined = false;
        if (node && node.nodeName === 'SCRIPT' && node.src && this.isConnected) {
          try {
            inlined = rewrite(node);
          } catch (e) {
            console.warn('[BetterNCM] hijack: rewrite failed', e);
          }
        }
        const ret = orig.call(this, node, ...rest);
        if (inlined) queueMicrotask(() => node.dispatchEvent(new Event('load')));
        return ret;
      },
    }[name];
    Object.defineProperty(Node.prototype, name, {
      value: wrapped, writable: true, configurable: true, enumerable: false,
    });
  }
  wrapInsert('appendChild');
  wrapInsert('insertBefore');
}

__bncmInstallHijacks();
