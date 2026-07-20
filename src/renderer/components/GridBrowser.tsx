import React, { useRef, useState, useCallback, useEffect } from 'react';
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
  const [addressBar, setAddressBar] = useState(url);
  const [currentTitle, setCurrentTitle] = useState('Browser');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const uiFontSize = Math.max(10, Math.round(zoomLevel * 0.85));

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

  const commitMainUrl = useCallback(
    (nextUrl: string) => {
      if (!nextUrl || nextUrl === lastCommittedUrlRef.current) return;
      lastCommittedUrlRef.current = nextUrl;
      lastRequestedUrlRef.current = nextUrl;
      setAddressBar(nextUrl);
      onUrlChangeRef.current(nextUrl);
    },
    [] // stable — uses ref for onUrlChange
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

  // Attach webview event listeners once on mount — never re-run.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
    const onTitleUpdate = (e: Electron.PageTitleUpdatedEvent) => {
      setCurrentTitle(e.title || 'Browser');
    };
    const onNavigation = (e: Electron.DidNavigateEvent) => {
      commitMainUrl(e.url);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
    const onNavigationInPage = (e: Electron.DidNavigateInPageEvent & { isMainFrame?: boolean }) => {
      if (e.isMainFrame === false) return;
      commitMainUrl(e.url);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
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
        requestNavigation(wv, target);
      }
    };

    // The focus-bridge preload posts this when the guest page is clicked/focused
    // (guest input never reaches the host window). Focus the owning pane.
    const onIpcMessage = (e: Electron.IpcMessageEvent) => {
      if (e.channel === 'splitgrid:guest-focus') onRequestFocusRef.current?.(containerId);
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
    wv.addEventListener('did-navigate', onNavigation);
    wv.addEventListener('did-navigate-in-page', onNavigationInPage);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('console-message', onConsoleMessage);
    wv.addEventListener('ipc-message', onIpcMessage);
    pendingUrlRef.current = initialSrcRef.current?.trim() || null;

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
      navigate: (target: string) => requestNavigation(wv, target),
      back: () => { if (wv.canGoBack()) wv.goBack(); },
      forward: () => { if (wv.canGoForward()) wv.goForward(); },
      reload: () => wv.reload(),
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
      wv.removeEventListener('did-navigate', onNavigation);
      wv.removeEventListener('did-navigate-in-page', onNavigationInPage);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('console-message', onConsoleMessage);
      wv.removeEventListener('ipc-message', onIpcMessage);
      unregisterBrowser(containerId);
      isDomReadyRef.current = false;
    };
  }, [applyWebviewZoom, containerId, requestNavigation]); // stable callbacks via refs

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

    let finalUrl = input.trim();
    if (!finalUrl) return;

    // If it looks like a URL, add protocol
    if (/^[\w-]+\.\w{2,}/.test(finalUrl) && !finalUrl.includes(' ')) {
      finalUrl = 'https://' + finalUrl;
    } else if (!/^https?:\/\//i.test(finalUrl)) {
      // Treat as search query
      finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
    }

    setAddressBar(finalUrl);
    if (isDomReadyRef.current) {
      requestNavigation(wv, finalUrl);
    } else {
      pendingUrlRef.current = finalUrl;
    }
  }, [requestNavigation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigate(addressBar);
      }
    },
    [addressBar, navigate]
  );

  const goBack = useCallback(() => webviewRef.current?.goBack(), []);
  const goForward = useCallback(() => webviewRef.current?.goForward(), []);
  const reload = useCallback(() => {
    if (isLoading) {
      webviewRef.current?.stop();
    } else {
      webviewRef.current?.reload();
    }
  }, [isLoading]);

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
          title="Back"
        >
          &#8592;
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          style={canGoForward ? navBtnStyle : disabledStyle}
          onMouseEnter={(e) => { if (canGoForward) e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="Forward"
        >
          &#8594;
        </button>
        <button
          onClick={reload}
          style={navBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={isLoading ? 'Stop' : 'Reload'}
        >
          {isLoading ? '\u00D7' : '\u21BB'}
        </button>
        <input
          type="text"
          value={addressBar}
          onChange={(e) => setAddressBar(e.target.value)}
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
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        />
      </div>

      {/* Webview */}
      <div style={{ flex: 1, position: 'relative' }}>
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
