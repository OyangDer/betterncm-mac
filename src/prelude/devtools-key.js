// F12 or Cmd-Opt-I opens DevTools for this page target (v2 opened them on F12 natively).
// The API server opens the DevTools frontend of the CDP port in the default browser.

const fetchFn = window.fetch.bind(window); // before page scripts can patch it

window.addEventListener('keydown', (e) => {
  const f12 = e.key === 'F12' || e.code === 'F12';
  const cmdOptI = e.metaKey && e.altKey && !e.ctrlKey && (e.code === 'KeyI' || e.key === 'i' || e.key === 'I');
  if (!f12 && !cmdOptI) return;
  e.preventDefault();
  e.stopPropagation();
  fetchFn(BETTERNCM_API_PATH + '/internal/devtools', {
    method: 'POST',
    headers: {
      BETTERNCM_API_KEY,
      'X-BNCM-Target': __BNCM_TARGET__,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target: __BNCM_TARGET__ }),
  }).catch((err) => console.warn('[BetterNCM] could not open DevTools', err));
}, true);
