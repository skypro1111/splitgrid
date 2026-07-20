// splitgrid <webview> focus bridge.
//
// Clicks (and keyboard focus) inside a guest page never reach the host window —
// the webview is a separate process — so the host's pointer/focus tracking can't
// see them, and the pane stayed unfocused until you clicked its chrome. This
// preload runs in every guest page and posts a host message on any interaction;
// the host (GridBrowser) focuses the owning container. Capture phase + window
// scope so it fires for any target, including an empty about:blank body.
const { ipcRenderer } = require('electron');

function notify() {
  try {
    ipcRenderer.sendToHost('splitgrid:guest-focus');
  } catch (e) {
    // host not ready / detached — ignore
  }
}

window.addEventListener('pointerdown', notify, true);
window.addEventListener('focusin', notify, true);
