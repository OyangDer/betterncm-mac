// Hides BetterNCM's plugin manager button next to NCM's settings button (config
// mac.pluginManager is not 'true'). Most plugin market plugins do not work on macOS, and the
// plugins betterncm-mac ships with need no managing; the market itself is not loaded either
// (src/plugins.mjs). The framework adds the button as a copy of NCM's settings button titled
// "BetterNCM".

const STYLE_ID = 'bncm-hide-plugin-manager';

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = '[title="BetterNCM"][role="button"] { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
else install();
