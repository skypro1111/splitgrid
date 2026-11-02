// splitgrid <webview> focus bridge.
//
// Clicks (and keyboard focus) inside a guest page never reach the host window —
// the webview is a separate process — so the host's pointer/focus tracking can't
// see them, and the pane stayed unfocused until you clicked its chrome. This
// preload runs in every guest page and posts a host message on any interaction;
// the host (GridBrowser) focuses the owning container. Capture phase + window
// scope so it fires for any target, including an empty about:blank body.
//
// It also forwards the page-overridable navigation input (back/forward chords,
// mouse back/forward buttons) to the host. Reload, DevTools and ⌘L/Ctrl+L are
// taken in main (before-input-event) before the page sees them; back/forward
// come through here so that, as in Chrome, a page that handles the key itself
// (an editor's ⌘[ outdent) wins. The page's say is checked after dispatch:
// stopPropagation alone doesn't cancel, only preventDefault does.
const { ipcRenderer } = require('electron');

function send(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.sendToHost(channel);
    else ipcRenderer.sendToHost(channel, payload);
  } catch {
    // host not ready / detached — ignore
  }
}

function notify() {
  send('splitgrid:guest-focus');
}

window.addEventListener('pointerdown', notify, true);
window.addEventListener('focusin', notify, true);

function isEditable(e) {
  const t = (e.composedPath && e.composedPath()[0]) || e.target;
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph']);

// Only chords (and the hardware Browser keys) — plain typing never leaves the page.
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted || e.isComposing || MODIFIER_KEYS.has(e.key)) return;
  const browserKey = e.key === 'BrowserBack' || e.key === 'BrowserForward';
  if (!browserKey && !(e.metaKey || e.ctrlKey || e.altKey)) return;
  const payload = {
    key: String(e.key),
    code: String(e.code || ''),
    meta: !!e.metaKey,
    control: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
    editable: isEditable(e),
  };
  setTimeout(() => {
    if (!e.defaultPrevented) send('splitgrid:guest-key', payload);
  }, 0);
}, true);

// Mouse back/forward side buttons (Chromium reports them as buttons 3 and 4).
window.addEventListener('mouseup', (e) => {
  if (!e.isTrusted || (e.button !== 3 && e.button !== 4)) return;
  const dir = e.button === 3 ? 'back' : 'forward';
  setTimeout(() => {
    if (!e.defaultPrevented) send('splitgrid:guest-nav', dir);
  }, 0);
}, true);
