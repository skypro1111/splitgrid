// ─── The code that runs inside the controlled page ───────────────────────────
// Every exported function here is handed to chrome.scripting.executeScript and
// serialised with Function.prototype.toString(), so each one must be entirely
// self-contained: no imports, no module-level constants, no shared helpers. The
// duplication below is the price of that and is deliberate.
//
// They run in the extension's ISOLATED world. That is what makes the handle we
// stash on `window` invisible to the page: an isolated world gets its own
// globals and its own expandos on the same DOM nodes, so the page can neither
// read our references nor reach into the closed shadow root through them.

/** The visual state, computed in the worker by indicator-state.ts. */
export interface FrameConfig {
  accent: string;
  ink: string;
  borderPx: number;
  dashed: boolean;
  filledDot: boolean;
  label: string;
}

/** Kept on the isolated world's `window` so later injections update in place. */
interface OverlayHandle {
  host: HTMLElement;
  root: HTMLElement;
  dot: HTMLElement;
  text: HTMLElement;
  guard: MutationObserver;
  /** Suppressed for a screenshot — survives a config update. */
  hidden: boolean;
  pulseTimer: number;
}

interface OverlayScope {
  __splitgridControl?: OverlayHandle;
}

/**
 * Create the frame if it is missing, then paint it for `cfg`. Idempotent: this
 * is both "inject" and "update", so a `writable` flip and a re-injection after
 * navigation are the same call.
 */
export function applyFrame(cfg: FrameConfig): void {
  const ATTR = 'data-splitgrid-control';

  // Inline + !important is the only author-level declaration a page cannot beat:
  // important inline styles outrank important rules from any stylesheet, and
  // `all:initial` first neutralises whatever the page inherited onto us
  // (`* { all: unset }`, a global transform, a filter, a clip-path).
  const HOST_CSS =
    'all:initial !important;' +
    'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;' +
    'width:100% !important;height:100% !important;max-width:none !important;max-height:none !important;' +
    'min-width:0 !important;min-height:0 !important;margin:0 !important;padding:0 !important;' +
    'border:0 !important;background:transparent !important;pointer-events:none !important;' +
    'display:block !important;opacity:1 !important;visibility:visible !important;' +
    'transform:none !important;filter:none !important;clip-path:none !important;mask:none !important;' +
    'isolation:isolate !important;z-index:2147483647 !important;';

  const CSS =
    '.sg-root{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;' +
    'font:600 11px/1.35 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
    '.sg-frame{position:absolute;top:0;left:0;right:0;bottom:0;box-sizing:border-box;' +
    'border:var(--sg-w) var(--sg-style) var(--sg-accent);}' +
    '.sg-flash{position:absolute;top:0;left:0;right:0;bottom:0;box-sizing:border-box;' +
    'border:calc(var(--sg-w) * 2.4) solid var(--sg-accent);opacity:0;}' +
    '.sg-label{position:absolute;top:0;right:0;margin:var(--sg-w);display:flex;align-items:center;' +
    'gap:6px;padding:3px 9px 4px;background:var(--sg-accent);color:var(--sg-ink);' +
    'letter-spacing:.045em;white-space:nowrap;border-radius:0 0 0 7px;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.3);}' +
    '.sg-dot{width:8px;height:8px;flex:none;box-sizing:border-box;border-radius:50%;' +
    'border:2px solid var(--sg-ink);}' +
    '.sg-dot--filled{background:var(--sg-ink);}' +
    '.sg-hidden{display:none !important;}' +
    // Opt IN to the pulse: a user asking for reduced motion simply never matches.
    '@media (prefers-reduced-motion: no-preference){' +
    '.sg-pulse .sg-flash{animation:sg-pulse 620ms ease-out 1;}' +
    '@keyframes sg-pulse{0%{opacity:0}18%{opacity:.6}100%{opacity:0}}}' +
    // A permanent border in a print-out is noise, same argument as screenshots.
    '@media print{.sg-root{display:none !important;}}';

  const doc = document;
  const html = doc.documentElement;
  if (!html) return;
  const scope = window as unknown as OverlayScope;
  let ov = scope.__splitgridControl;

  if (!ov || !ov.host.isConnected) {
    // Retire the previous guard first, or it would resurrect the host we are
    // about to sweep and the document would end up with two frames.
    if (ov) {
      ov.guard.disconnect();
      if (ov.pulseTimer) clearTimeout(ov.pulseTimer);
    }
    // Exactly one frame per document: drop anything left by an earlier
    // injection whose handle we lost, or a copy the page cloned.
    const stale = html.querySelectorAll('[' + ATTR + ']');
    for (let i = 0; i < stale.length; i++) stale[i].remove();

    const host = doc.createElement('div');
    host.setAttribute(ATTR, '');
    // Decorative: the popup is the accessible source of truth, and this frame
    // is non-interactive text a screen-reader user could not act on anyway.
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('style', HOST_CSS);

    // Closed, so page script cannot walk into it even though it can see the
    // host (the stable attribute is a deliberate, externally checkable contract).
    // A second attachShadow() on the same element throws, so the page cannot
    // replace this one either.
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS;

    const root = doc.createElement('div');
    root.className = 'sg-root';
    const frame = doc.createElement('div');
    frame.className = 'sg-frame';
    const flash = doc.createElement('div');
    flash.className = 'sg-flash';
    const label = doc.createElement('div');
    label.className = 'sg-label';
    const dot = doc.createElement('span');
    dot.className = 'sg-dot';
    const text = doc.createElement('span');
    label.appendChild(dot);
    label.appendChild(text);
    root.appendChild(frame);
    root.appendChild(flash);
    root.appendChild(label);
    shadow.appendChild(style);
    shadow.appendChild(root);
    html.appendChild(host);

    // The page can reach the host element; it must not be able to delete it or
    // restyle it. `harden` only writes when something actually differs, so our
    // own repairs cannot drive the observer in a loop.
    const harden = (): void => {
      if (!host.isConnected && doc.documentElement) doc.documentElement.appendChild(host);
      if (host.getAttribute('style') !== HOST_CSS) host.setAttribute('style', HOST_CSS);
      if (!host.hasAttribute(ATTR)) host.setAttribute(ATTR, '');
      if (host.getAttribute('aria-hidden') !== 'true') host.setAttribute('aria-hidden', 'true');
    };
    const guard = new MutationObserver(harden);
    guard.observe(html, { childList: true });
    guard.observe(host, { attributes: true, attributeFilter: ['style', ATTR, 'aria-hidden'] });

    ov = { host, root, dot, text, guard, hidden: false, pulseTimer: 0 };
    scope.__splitgridControl = ov;
  }

  const vars = ov.root.style;
  vars.setProperty('--sg-accent', cfg.accent);
  vars.setProperty('--sg-ink', cfg.ink);
  vars.setProperty('--sg-w', cfg.borderPx + 'px');
  vars.setProperty('--sg-style', cfg.dashed ? 'dashed' : 'solid');
  ov.dot.className = cfg.filledDot ? 'sg-dot sg-dot--filled' : 'sg-dot';
  ov.text.textContent = cfg.label;
  // A repaint must not un-hide a frame suppressed for an in-flight capture.
  ov.root.classList.toggle('sg-hidden', ov.hidden);
}

/** Take the frame down. Also the cleanup path after a service-worker restart. */
export function removeFrame(): void {
  const ATTR = 'data-splitgrid-control';
  const scope = window as unknown as OverlayScope;
  const ov = scope.__splitgridControl;
  if (ov) {
    // Before the removal, or the guard would dutifully put it back.
    ov.guard.disconnect();
    if (ov.pulseTimer) clearTimeout(ov.pulseTimer);
    scope.__splitgridControl = undefined;
  }
  const nodes = document.querySelectorAll('[' + ATTR + ']');
  for (let i = 0; i < nodes.length; i++) nodes[i].remove();
}

/**
 * Hide/show for the duration of a CDP capture. The host element stays in the
 * DOM — the tab IS still controlled, so the externally checkable attribute must
 * keep saying so; only the pixels go away.
 */
export function setFrameHidden(hidden: boolean): void {
  const scope = window as unknown as OverlayScope;
  const ov = scope.__splitgridControl;
  if (!ov) return;
  ov.hidden = hidden;
  ov.root.classList.toggle('sg-hidden', hidden);
}

/** One short flash when a command actually executes. No idle animation. */
export function pulseFrame(): void {
  const scope = window as unknown as OverlayScope;
  const ov = scope.__splitgridControl;
  if (!ov || ov.hidden) return;
  const root = ov.root;
  root.classList.remove('sg-pulse');
  // Force layout so a second command within the pulse restarts the animation.
  root.getBoundingClientRect();
  root.classList.add('sg-pulse');
  if (ov.pulseTimer) clearTimeout(ov.pulseTimer);
  ov.pulseTimer = setTimeout(() => root.classList.remove('sg-pulse'), 700);
}
