import React, { useRef, useState, useCallback, useEffect } from 'react';
import { PaneFocusButton } from './focusMode';
import { normalizeBrowserInput } from '../../shared/browser-url';
import {
  matchBrowserShortcut,
  type BrowserShortcutAction,
} from '../../shared/browser-shortcuts';
import { SplitHorizontalIcon, SplitVerticalIcon } from './Icons';
import {
  registerBrowser,
  unregisterBrowser,
  type BrowserPaneApi,
  type ConsoleEntry,
} from './browserRegistry';
import {
  snapshotScript,
  clickScript,
  fillScript,
  typeScript,
  selectScript,
  waitSelectorScript,
  waitTextScript,
  sleepScript,
  hoverScript,
  focusScript,
  dblclickScript,
  checkScript,
  scrollScript,
  scrollIntoViewScript,
  getElementScript,
  isStateScript,
  findScript,
  pushStateScript,
  storageScript,
  waitUrlScript,
  waitFnScript,
} from './browserAutomation';

// Run an automation IIFE in the guest page and JSON-parse its reply. The script
// always returns a JSON string (a bare undefined would crash the renderer), so a
// null/parse failure means the page returned nothing usable.
function runPageScript(wv: Electron.WebviewTag, js: string): Promise<unknown> {
  return wv
    .executeJavaScript(js, true)
    .then((s) => {
      try { return s == null ? { ok: false, error: 'no_result' } : JSON.parse(s as string); }
      catch { return { ok: false, error: 'bad_result', raw: String(s).slice(0, 200) }; }
    })
    .catch((err) => ({ ok: false, error: String((err as Error)?.message || err) }));
}

const CONSOLE_BUFFER_MAX = 200;
// Chromium console-message levels (verified live: console.log→1, CSP warning→2).
const CONSOLE_LEVEL: Record<number, string> = { 0: 'debug', 1: 'log', 2: 'warning', 3: 'error' };
// net::ERR_ABORTED — a navigation replaced by another one, a download, or stop().
// Not a failure worth showing.
const NET_ERR_ABORTED = -3;

// The blank start page reads as an empty address bar, as in a new Chrome tab.
const displayUrl = (u: string) => (u === 'about:blank' ? '' : u);

interface LoadError {
  url: string;
  code: number;
  description: string;
}

// Code-brackets glyph for the DevTools button.
const DevToolsIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface GridBrowserProps {
  url: string;
  partition: string;
  zoomLevel: number;
  containerId: string;
  onRequestFocus?: (containerId: string) => void;
  onClose: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onUrlChange: (url: string) => void;
}

export const GridBrowser: React.FC<GridBrowserProps> = ({
  url,
  partition,
  zoomLevel,
  containerId,
  onRequestFocus,
  onClose,
  onSplitRight,
  onSplitDown,
  onUrlChange,
}) => {
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const initialSrcRef = useRef(url);
  const lastCommittedUrlRef = useRef(url);
  const isDomReadyRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef('');
  const zoomLevelRef = useRef(zoomLevel);
  zoomLevelRef.current = zoomLevel;
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  // The user has typed into the address bar since it last showed the page URL —
  // a navigation (redirect, SPA route change) must not clobber the edit while
  // the bar still has focus.
  const addressDirtyRef = useRef(false);
  // First mouse click into the unfocused bar selects the whole URL (Chrome).
  const selectOnMouseUpRef = useRef(false);
  // URL of the main-frame load that failed and is now showing the blank error
  // page. Reload retries THIS — the guest's own reload() may reload the entry
  // before it (the initial about:blank) when the failure never committed.
  const failedUrlRef = useRef<string | null>(null);
  // Set when the current main-frame navigation has committed (did-navigate);
  // a did-fail-load after that is a post-commit hiccup of a page that rendered,
  // not a failed load.
  const committedSinceStartRef = useRef(true);
  // The guest boots on about:blank and then loads the pane's URL; that first
  // entry is dropped from history once the real page commits, so Back doesn't
  // land on a blank page (and persist about:blank as the pane's URL).
  const clearHistoryOnCommitRef = useRef(false);
  const [addressBar, setAddressBar] = useState(displayUrl(url));
  const [currentTitle, setCurrentTitle] = useState('Browser');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const uiFontSize = Math.max(10, Math.round(zoomLevel * 0.85));
  const isMac = window.electronAPI.platform === 'darwin';

  // Stable refs for callbacks to avoid effect re-runs on every render.
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const onRequestFocusRef = useRef(onRequestFocus);
  onRequestFocusRef.current = onRequestFocus;

  // Focus-mode (and other callers) ask this container to take focus. The host
  // <webview>.focus() forwards keyboard focus into the guest page — a plain DOM
  // focus on the element from outside doesn't reach the guest.
  useEffect(() => {
    const onFocusRequest = (e: Event) => {
      if ((e as CustomEvent<{ containerId?: string }>).detail?.containerId === containerId) {
        webviewRef.current?.focus();
      }
    };
    window.addEventListener('splitgrid:focus-container', onFocusRequest);
    return () => window.removeEventListener('splitgrid:focus-container', onFocusRequest);
  }, [containerId]);

  // Ring buffer of page console messages for the agent `get console` command.
  const consoleBufRef = useRef<ConsoleEntry[]>([]);

  const applyWebviewZoom = useCallback((wv: Electron.WebviewTag, level = zoomLevelRef.current) => {
    const zoomFactor = Math.max(0.5, Math.min(3, level / 13));
    try {
      wv.setZoomFactor(zoomFactor);
    } catch {
      // Best effort — webview can reject calls during transient load states.
    }
  }, []);

  // Show a URL in the address bar unless the user is mid-edit there.
  const showUrl = useCallback((nextUrl: string) => {
    const input = addressInputRef.current;
    if (addressDirtyRef.current && input && document.activeElement === input) return;
    addressDirtyRef.current = false;
    setAddressBar(displayUrl(nextUrl));
  }, []);

  const commitMainUrl = useCallback(
    (nextUrl: string) => {
      if (!nextUrl) return;
      // Always refresh the bar: after a failed load it shows the failed URL while
      // lastCommittedUrlRef still holds the page before it, so going Back to that
      // page must put its URL back even though the committed URL "didn't change".
      // The about:blank boot page doesn't blank the bar while the pane's own URL
      // is still waiting to load.
      if (!(nextUrl === 'about:blank' && pendingUrlRef.current)) showUrl(nextUrl);
      if (nextUrl === lastCommittedUrlRef.current) return;
      lastCommittedUrlRef.current = nextUrl;
      lastRequestedUrlRef.current = nextUrl;
      // The blank boot page is never the pane's URL worth restoring.
      if (nextUrl !== 'about:blank') onUrlChangeRef.current(nextUrl);
    },
    [showUrl] // stable — uses ref for onUrlChange
  );

  const requestNavigation = useCallback((wv: Electron.WebviewTag, targetUrl: string) => {
    if (!targetUrl) return;
    if (lastRequestedUrlRef.current === targetUrl) return;
    lastRequestedUrlRef.current = targetUrl;
    try {
      wv.setAttribute('src', targetUrl);
    } catch (error) {
      console.error('Failed to navigate webview:', targetUrl, error);
    }
  }, []);

  // Explicit navigation (address-bar Enter, agent open/navigate). Asking for the
  // URL that's already loaded — e.g. retrying once the dev server is up, after the
  // first load failed — must load it again; requestNavigation's dedupe (still used
  // for the initial dom-ready navigation) would silently swallow it.
  const explicitNavigate = useCallback((wv: Electron.WebviewTag, targetUrl: string) => {
    if (!targetUrl) return;
    if (isDomReadyRef.current) {
      let current = '';
      try { current = wv.getURL(); } catch { /* not attached yet */ }
      if (targetUrl === current) {
        lastRequestedUrlRef.current = targetUrl;
        wv.reload();
        return;
      }
      if (targetUrl === lastRequestedUrlRef.current) {
        // Same target as the last request but not what's showing (load failed
        // elsewhere / still in flight): force a fresh load.
        wv.loadURL(targetUrl).catch(() => { /* failure surfaces as did-fail-load */ });
        return;
      }
    }
    requestNavigation(wv, targetUrl);
  }, [requestNavigation]);

  // Toolbar / shortcut / context-menu / agent actions. All stable (refs only) so
  // the mount-once effect and the IPC listeners can hold them. Each guards on a
  // live, dom-ready guest — the webview's methods throw before it attaches.
  const reloadPage = useCallback((ignoreCache = false) => {
    const wv = webviewRef.current;
    if (!wv || !isDomReadyRef.current) return;
    const failed = failedUrlRef.current;
    try {
      if (failed) {
        // Retry what failed (dev server not up yet, …), not the error page.
        wv.loadURL(failed).catch(() => { /* failure surfaces as did-fail-load */ });
      } else if (ignoreCache) {
        wv.reloadIgnoringCache();
      } else {
        wv.reload();
      }
    } catch { /* guest detached */ }
  }, []);

  const stopLoading = useCallback(() => {
    try { webviewRef.current?.stop(); } catch { /* guest detached */ }
  }, []);

  const goBack = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !isDomReadyRef.current) return;
    try { if (wv.canGoBack()) wv.goBack(); } catch { /* guest detached */ }
  }, []);

  const goForward = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !isDomReadyRef.current) return;
    try { if (wv.canGoForward()) wv.goForward(); } catch { /* guest detached */ }
  }, []);

  // DevTools for the guest page only. A webview's DevTools can't dock inside the
  // pane, so Electron opens them in their own window.
  const toggleDevTools = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !isDomReadyRef.current) return;
    try {
      if (wv.isDevToolsOpened()) wv.closeDevTools();
      else wv.openDevTools();
    } catch { /* guest detached */ }
  }, []);

  const focusAddressBar = useCallback(() => {
    const input = addressInputRef.current;
    if (!input) return;
    onRequestFocusRef.current?.(containerId);
    input.focus();
    input.select();
  }, [containerId]);

  const runShortcut = useCallback((action: BrowserShortcutAction) => {
    switch (action) {
      case 'reload': reloadPage(false); break;
      case 'hard-reload': reloadPage(true); break;
      case 'back': goBack(); break;
      case 'forward': goForward(); break;
      case 'focus-address': focusAddressBar(); break;
      case 'devtools': toggleDevTools(); break;
    }
  }, [reloadPage, goBack, goForward, focusAddressBar, toggleDevTools]);

  // Attach webview event listeners once on mount — never re-run.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const syncNavState = () => {
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
      } catch { /* guest detached */ }
    };
    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      syncNavState();
    };
    const onTitleUpdate = (e: Electron.PageTitleUpdatedEvent) => {
      setCurrentTitle(e.title || 'Browser');
    };
    const onStartNavigation = (e: Electron.DidStartNavigationEvent) => {
      if (!e.isMainFrame || e.isInPlace) return;
      committedSinceStartRef.current = false;
      setLoadError(null);
    };
    const onNavigation = (e: Electron.DidNavigateEvent) => {
      committedSinceStartRef.current = true;
      failedUrlRef.current = null;
      setLoadError(null);
      if (clearHistoryOnCommitRef.current && e.url && e.url !== 'about:blank') {
        clearHistoryOnCommitRef.current = false;
        try { wv.clearHistory(); } catch { /* guest detached */ }
      }
      commitMainUrl(e.url);
      syncNavState();
    };
    const onNavigationInPage = (e: Electron.DidNavigateInPageEvent & { isMainFrame?: boolean }) => {
      if (e.isMainFrame === false) return;
      commitMainUrl(e.url);
      syncNavState();
    };
    // A main-frame load failed: Electron shows a blank page, so surface the error
    // (overlay below) and remember the URL so Reload retries it.
    const onFailLoad = (e: Electron.DidFailLoadEvent) => {
      if (!e.isMainFrame || e.errorCode === NET_ERR_ABORTED || committedSinceStartRef.current) return;
      const failedUrl = e.validatedURL || '';
      failedUrlRef.current = failedUrl || null;
      setLoadError({ url: failedUrl, code: e.errorCode, description: e.errorDescription || '' });
      if (failedUrl) showUrl(failedUrl);
      syncNavState();
    };
    const onDevToolsOpened = () => setDevToolsOpen(true);
    const onDevToolsClosed = () => setDevToolsOpen(false);
    let initialNavDone = false;
    const onDomReady = () => {
      isDomReadyRef.current = true;
      applyWebviewZoom(wv);
      // Only handle pending/initial navigation on the FIRST dom-ready.
      // Subsequent dom-ready events fire on every page load and must be ignored
      // to avoid re-navigating back to the initial URL after redirects.
      if (initialNavDone) return;
      initialNavDone = true;
      const target = pendingUrlRef.current ?? initialSrcRef.current?.trim();
      pendingUrlRef.current = null;
      if (target && target !== 'about:blank') {
        clearHistoryOnCommitRef.current = true;
        requestNavigation(wv, target);
      }
    };

    // Messages from the guest preload (resources/webview-focus.js) — guest input
    // never reaches the host window. Page-controlled data: validate everything.
    const onIpcMessage = (e: Electron.IpcMessageEvent) => {
      // Guest clicked/focused: focus the owning pane.
      if (e.channel === 'splitgrid:guest-focus') {
        onRequestFocusRef.current?.(containerId);
        return;
      }
      // A chord the page didn't preventDefault. Only back/forward act here; the
      // reserved ones (reload, DevTools, ⌘L) main already took before the page.
      if (e.channel === 'splitgrid:guest-key') {
        const p = e.args?.[0] as Record<string, unknown> | undefined;
        if (!p || typeof p !== 'object' || typeof p.key !== 'string') return;
        const action = matchBrowserShortcut(
          {
            key: p.key,
            code: typeof p.code === 'string' ? p.code : undefined,
            meta: p.meta === true,
            control: p.control === true,
            alt: p.alt === true,
            shift: p.shift === true,
          },
          { platform: window.electronAPI.platform, editable: p.editable === true },
        );
        if (action === 'back') goBack();
        else if (action === 'forward') goForward();
        return;
      }
      // Mouse back/forward side buttons.
      if (e.channel === 'splitgrid:guest-nav') {
        if (e.args?.[0] === 'back') goBack();
        else if (e.args?.[0] === 'forward') goForward();
      }
    };

    // Buffer page console output for the agent `get console` command.
    const onConsoleMessage = (e: Electron.ConsoleMessageEvent) => {
      const buf = consoleBufRef.current;
      buf.push({ level: CONSOLE_LEVEL[e.level] ?? 'log', text: e.message, at: Date.now() });
      if (buf.length > CONSOLE_BUFFER_MAX) buf.splice(0, buf.length - CONSOLE_BUFFER_MAX);
    };

    wv.addEventListener('did-start-loading', onStartLoad);
    wv.addEventListener('did-stop-loading', onStopLoad);
    wv.addEventListener('page-title-updated', onTitleUpdate);
    wv.addEventListener('did-start-navigation', onStartNavigation);
    wv.addEventListener('did-navigate', onNavigation);
    wv.addEventListener('did-navigate-in-page', onNavigationInPage);
    wv.addEventListener('did-fail-load', onFailLoad);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('console-message', onConsoleMessage);
    wv.addEventListener('ipc-message', onIpcMessage);
    wv.addEventListener('devtools-opened', onDevToolsOpened);
    wv.addEventListener('devtools-closed', onDevToolsClosed);
    pendingUrlRef.current = normalizeBrowserInput(initialSrcRef.current ?? '') || null;

    // Expose an imperative API so the agent browser bridge can drive this pane.
    // All calls run against the live <webview>; `eval` is page-scoped JS via
    // executeJavaScript (gated upstream by $SPLITGRID_BROWSER_TOKEN), not a process
    // eval. Methods guard on webview presence and resolve best-effort.
    const api: BrowserPaneApi = {
      getUrl: () => { try { return wv.getURL(); } catch { return ''; } },
      getTitle: () => { try { return wv.getTitle(); } catch { return ''; } },
      getText: () =>
        wv.executeJavaScript('document.body ? document.body.innerText : ""', true).then(String),
      getHtml: () =>
        wv.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""', true).then(String),
      navigate: (target: string) => explicitNavigate(wv, target),
      back: () => { if (wv.canGoBack()) wv.goBack(); },
      forward: () => { if (wv.canGoForward()) wv.goForward(); },
      // Same as the toolbar: after a failed load, retry its URL.
      reload: () => reloadPage(false),
      getWebContentsId: () => { try { return wv.getWebContentsId(); } catch { return -1; } },
      // Run the agent's JS via page `eval()` of a JSON-escaped string so BOTH a
      // single expression and multi-statement code work (eval yields the
      // completion value, REPL-style). We JSON-encode the result (null for
      // undefined) and parse it back: a bare `undefined` from executeJavaScript
      // hands V8 an empty MaybeLocal and hard-crashes the renderer, so the result
      // must always be a non-empty string. Errors come back as data.
      eval: (js: string) =>
        wv
          .executeJavaScript(
            `(function(){try{var __r=eval(${JSON.stringify(js)});return JSON.stringify(__r===undefined?null:__r);}catch(e){return JSON.stringify({__evalError:String(e)});}})()`,
            true,
          )
          .then((s) => { try { return s == null ? null : JSON.parse(s as string); } catch { return s; } }),
      getConsole: () => [...consoleBufRef.current],
      // Interactive automation: each script is an IIFE returning a JSON string
      // (see browserAutomation.ts); parse it back into a structured result.
      snapshot: (opts) => runPageScript(wv, snapshotScript(opts)),
      click: (target) => runPageScript(wv, clickScript(target)),
      fill: (target, text) => runPageScript(wv, fillScript(target, text)),
      type: (text) => runPageScript(wv, typeScript(text)),
      selectOption: (target, value) => runPageScript(wv, selectScript(target, value)),
      hover: (target) => runPageScript(wv, hoverScript(target)),
      focus: (target) => runPageScript(wv, focusScript(target)),
      dblclick: (target) => runPageScript(wv, dblclickScript(target)),
      setChecked: (target, checked) => runPageScript(wv, checkScript(target, checked)),
      scroll: (direction, px) => runPageScript(wv, scrollScript(direction, px)),
      scrollIntoView: (target) => runPageScript(wv, scrollIntoViewScript(target)),
      getElement: (what, selector, attr) => runPageScript(wv, getElementScript(what, selector, attr)),
      isState: (what, selector) => runPageScript(wv, isStateScript(what, selector)),
      find: (strategy, query, action, value) => runPageScript(wv, findScript(strategy, query, action, value)),
      pushState: (url) => runPageScript(wv, pushStateScript(url)),
      storage: (area, op, key, value) => runPageScript(wv, storageScript(area, op, key, value)),
      waitUrl: (pattern, timeoutMs) => runPageScript(wv, waitUrlScript(pattern, timeoutMs)),
      waitFn: (js, timeoutMs) => runPageScript(wv, waitFnScript(js, timeoutMs)),
      // Resolve when the pane stops loading. did-stop-loading fires per page load;
      // if already idle, resolve immediately. Timeout resolves (not rejects) so
      // the agent gets a clean reply.
      waitLoad: (timeoutMs) =>
        new Promise((resolve) => {
          let done = false;
          const finish = (r: Record<string, unknown>) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            wv.removeEventListener('did-stop-loading', onStop);
            resolve(r);
          };
          const onStop = () => finish({ ok: true, loaded: true });
          const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
          let loading = true;
          try { loading = wv.isLoading(); } catch { /* assume loading */ }
          if (!loading) finish({ ok: true, loaded: true, alreadyIdle: true });
          else wv.addEventListener('did-stop-loading', onStop);
        }),
      waitSelector: (selector, timeoutMs) => runPageScript(wv, waitSelectorScript(selector, timeoutMs)),
      waitText: (text, timeoutMs) => runPageScript(wv, waitTextScript(text, timeoutMs)),
      sleep: (ms) => runPageScript(wv, sleepScript(ms)),
    };
    registerBrowser(containerId, api);

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoad);
      wv.removeEventListener('did-stop-loading', onStopLoad);
      wv.removeEventListener('page-title-updated', onTitleUpdate);
      wv.removeEventListener('did-start-navigation', onStartNavigation);
      wv.removeEventListener('did-navigate', onNavigation);
      wv.removeEventListener('did-navigate-in-page', onNavigationInPage);
      wv.removeEventListener('did-fail-load', onFailLoad);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('console-message', onConsoleMessage);
      wv.removeEventListener('ipc-message', onIpcMessage);
      wv.removeEventListener('devtools-opened', onDevToolsOpened);
      wv.removeEventListener('devtools-closed', onDevToolsClosed);
      unregisterBrowser(containerId);
      isDomReadyRef.current = false;
    };
  }, [applyWebviewZoom, commitMainUrl, containerId, requestNavigation, explicitNavigate, reloadPage, goBack, goForward, showUrl]); // stable callbacks via refs

  // Reserved chords main took from the guest before the page saw them (reload,
  // hard reload, DevTools, focus address bar), addressed by guest webContents id.
  useEffect(() => {
    return window.electronAPI.onBrowserGuestShortcut?.((webContentsId, action) => {
      const wv = webviewRef.current;
      if (!wv || !isDomReadyRef.current) return;
      // -1: a chord main took from the host window (Cmd/Ctrl+R), meant for the
      // pane whose address bar has focus.
      if (webContentsId === -1) {
        if (document.activeElement === addressInputRef.current) runShortcut(action);
        return;
      }
      let ownId = -1;
      try { ownId = wv.getWebContentsId(); } catch { /* not attached */ }
      if (ownId === webContentsId) runShortcut(action);
    });
  }, [runShortcut]);

  // Do not mirror prop `url` back into webview after mount.
  // `onUrlChange` already reports navigation upstream; mirroring it back causes
  // feedback loops and repeated aborts on redirect-heavy sites.

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !isDomReadyRef.current) return;
    applyWebviewZoom(wv, zoomLevel);
  }, [zoomLevel, applyWebviewZoom]);

  const navigate = useCallback((input: string) => {
    const wv = webviewRef.current;
    if (!wv) return;

    // Paths and scheme-less dev servers load directly; see shared/browser-url.
    const finalUrl = normalizeBrowserInput(input);
    if (!finalUrl) return;

    addressDirtyRef.current = false;
    setAddressBar(displayUrl(finalUrl));
    if (isDomReadyRef.current) {
      explicitNavigate(wv, finalUrl);
    } else {
      pendingUrlRef.current = finalUrl;
    }
  }, [explicitNavigate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // IME: the Enter/Esc that commits/cancels a composition isn't ours.
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        navigate(addressBar);
        // Hand the keyboard to the page, as Chrome does after Enter.
        webviewRef.current?.focus();
      } else if (e.key === 'Escape') {
        // Revert an edit to the page's URL and keep the bar selected.
        e.preventDefault();
        addressDirtyRef.current = false;
        setAddressBar(displayUrl(failedUrlRef.current ?? lastCommittedUrlRef.current));
        const input = e.currentTarget;
        requestAnimationFrame(() => input.select());
      }
    },
    [addressBar, navigate]
  );

  // Pane-chrome side of the browser shortcuts (address bar / buttons focused).
  // Keys typed in the page never get here — main and the guest preload cover
  // those. ⌘R / Ctrl+R can't arrive either: the app window's before-input-event
  // swallows it (F5 works).
  const handlePaneKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing) return;
      const t = e.target as HTMLElement;
      const editable = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      const action = matchBrowserShortcut(
        { key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
        { platform: window.electronAPI.platform, editable },
      );
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runShortcut(action);
    },
    [runShortcut]
  );

  const reloadOrStop = useCallback(() => {
    if (isLoading) stopLoading();
    else reloadPage(false);
  }, [isLoading, stopLoading, reloadPage]);

  const navBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '4px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    fontSize: '14px',
    flexShrink: 0,
    padding: 0,
  };

  const disabledStyle: React.CSSProperties = {
    ...navBtnStyle,
    opacity: 0.3,
    cursor: 'default',
  };

  return (
    <div
      onKeyDown={handlePaneKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        fontSize: `${uiFontSize}px`,
        background: 'var(--bg-primary)',
        overflow: 'hidden',
        border: '1px solid var(--border)',
      }}
    >
      {/* Title bar (drag handle) */}
      <div
        className="container-drag-handle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 10px',
          height: '32px',
          minHeight: '32px',
          background: 'var(--bg-titlebar)',
          borderBottom: '1px solid var(--border)',
          userSelect: 'none',
          cursor: 'grab',
        }}
      >
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          title="Close"
          style={{
            width: '12px', height: '12px', borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '8px', color: 'transparent', background: 'var(--accent-red)',
            border: 'none', cursor: 'pointer', flexShrink: 0, lineHeight: 1, opacity: 0.7,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--bg-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'transparent'; }}
        >
          x
        </button>
        <PaneFocusButton containerId={containerId} />
        <span
          style={{
            fontSize: '0.9em',
            fontWeight: 600,
            color: 'var(--text-muted)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {currentTitle}
        </span>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSplitRight}
          title="Split right"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitHorizontalIcon size={14} />
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onSplitDown}
          title="Split down"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', borderRadius: '4px', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <SplitVerticalIcon size={14} />
        </button>
      </div>

      {/* Navigation bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 8px',
          height: '34px',
          minHeight: '34px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <button
          onClick={goBack}
          disabled={!canGoBack}
          style={canGoBack ? navBtnStyle : disabledStyle}
          onMouseEnter={(e) => { if (canGoBack) e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={isMac ? 'Back (\u2318[)' : 'Back (Alt+\u2190)'}
        >
          &#8592;
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          style={canGoForward ? navBtnStyle : disabledStyle}
          onMouseEnter={(e) => { if (canGoForward) e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={isMac ? 'Forward (\u2318])' : 'Forward (Alt+\u2192)'}
        >
          &#8594;
        </button>
        <button
          onClick={reloadOrStop}
          style={navBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={isLoading ? 'Stop' : isMac ? 'Reload (\u2318R)' : 'Reload (Ctrl+R)'}
        >
          {isLoading ? '\u00D7' : '\u21BB'}
        </button>
        <input
          ref={addressInputRef}
          type="text"
          value={addressBar}
          placeholder="Search or enter address"
          onChange={(e) => { addressDirtyRef.current = true; setAddressBar(e.target.value); }}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          style={{
            flex: 1,
            height: '26px',
            padding: '0 10px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontSize: '1em',
            outline: 'none',
            fontFamily: 'inherit',
          }}
          // Chrome-style: focusing the bar selects the whole URL. A first click
          // would drop the caret and undo that on mouseup, so re-select there —
          // unless the click was a drag that selected something itself.
          onMouseDown={(e) => { selectOnMouseUpRef.current = document.activeElement !== e.currentTarget; }}
          onMouseUp={(e) => {
            const input = e.currentTarget;
            if (selectOnMouseUpRef.current && input.selectionStart === input.selectionEnd) {
              e.preventDefault();
              input.select();
            }
            selectOnMouseUpRef.current = false;
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.select(); }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        />
        <button
          onClick={toggleDevTools}
          style={{ ...navBtnStyle, color: devToolsOpen ? 'var(--accent)' : 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={`${devToolsOpen ? 'Close' : 'Open'} DevTools (${isMac ? 'F12 / \u2318\u2325I' : 'F12 / Ctrl+Shift+I'})`}
        >
          <DevToolsIcon />
        </button>
      </div>

      {/* Webview */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Loading sweep along the top edge. Absolutely positioned (no layout
            shift → no webview resize) and promoted to its own layer so it paints
            above the GPU-composited <webview>. */}
        {isLoading && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: '2px', overflow: 'hidden',
              zIndex: 3, pointerEvents: 'none', transform: 'translateZ(0)', color: 'var(--accent)',
            }}
          >
            <div
              style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, width: '33%',
                background: 'currentColor', animation: 'agentActivitySweep 1.15s ease-in-out infinite',
              }}
            />
          </div>
        )}
        {/* A failed main-frame load leaves Electron's blank error page; say what
            happened and offer the retry. Clicking hands focus back to the guest
            so ⌘R / F5 keep working from there. */}
        {loadError && (
          <div
            onMouseDown={() => webviewRef.current?.focus()}
            style={{
              position: 'absolute', inset: 0, zIndex: 2, transform: 'translateZ(0)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: '8px', padding: '24px', textAlign: 'center',
              background: 'var(--bg-primary)', color: 'var(--text-muted)',
            }}
          >
            <div style={{ fontSize: '1.15em', fontWeight: 600, color: 'var(--text-primary)' }}>
              This page couldn&apos;t be loaded
            </div>
            {loadError.url && (
              <div style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>{loadError.url}</div>
            )}
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.9em' }}>
              {loadError.description || `Error ${loadError.code}`}
            </div>
            <button
              onClick={() => reloadPage(false)}
              style={{
                marginTop: '6px', padding: '4px 14px', borderRadius: '6px', cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--bg-surface)',
                color: 'var(--text-primary)', fontSize: '1em', fontFamily: 'inherit',
              }}
            >
              Reload
            </button>
          </div>
        )}
        <webview
          ref={webviewRef as any}
          partition={partition}
          src="about:blank"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
          }}
          /* @ts-ignore - webview attributes */
          allowpopups="true"
          /* UA: inherits app.userAgentFallback (real Chrome, no Electron token). */
          /* @ts-ignore - focus-bridge preload: guest click → focus owning pane */
          preload={window.electronAPI.webviewPreloadUrl || undefined}
        />
      </div>
    </div>
  );
};
