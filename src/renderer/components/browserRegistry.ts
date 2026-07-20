// Registry of mounted browser panes, keyed by container id. Each GridBrowser
// registers an imperative API over its <webview> on mount; the agent browser
// bridge (useBrowserAgentBridge) looks a pane up by id and drives it. This keeps
// the renderer the single source of truth for live webviews — main never touches
// the DOM, it only relays commands.

export interface ConsoleEntry {
  level: string;
  text: string;
  at: number;
}

export interface BrowserPaneApi {
  getUrl(): string;
  getTitle(): string;
  getText(): Promise<string>;
  getHtml(): Promise<string>;
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  /**
   * webContents id of the guest page, for capturing a screenshot in the MAIN
   * process (`webContents.fromId(id).capturePage()`). Capturing from the renderer
   * via `<webview>.capturePage()` can hard-crash the renderer (V8 "Empty
   * MaybeLocal"), so we hand the id to main instead. Returns -1 if not attached.
   */
  getWebContentsId(): number;
  /**
   * Evaluate JS *inside the embedded page* via `webContents.executeJavaScript`
   * (NOT a JS eval() in our renderer/process). This is the deliberate, documented
   * browser-automation command — the same surface agent-browser/cmux expose — and
   * it is gated upstream by the per-run $SPLITGRID_BROWSER_TOKEN. Resolves the
   * (JSON-serializable) result.
   */
  eval(js: string): Promise<unknown>;
  /** Buffered console messages (most recent last). */
  getConsole(): ConsoleEntry[];
  // ── Interactive automation (injected-JS DOM walk) ──
  /**
   * Tag every visible interactive element (across same-origin iframes) with a
   * stable `data-splitgrid-ref` ("e1", "e2", …) and return a compact tree the agent
   * can act on. Source of refs for click/fill/select. `viewportOnly` restricts to
   * elements intersecting the viewport.
   */
  snapshot(opts?: { viewportOnly?: boolean }): Promise<unknown>;
  /** Click an element by snapshot ref ("e1") OR raw CSS selector. */
  click(target: string): Promise<unknown>;
  /** Replace the value of the input/textarea/contenteditable (ref or selector). */
  fill(target: string, text: string): Promise<unknown>;
  /** Append text to the currently-focused field (no target; uses activeElement). */
  type(text: string): Promise<unknown>;
  /** Select an <option> of a <select> (ref or selector) by value/label. */
  selectOption(target: string, value: string): Promise<unknown>;
  /** Hover an element (ref or selector) — fires the pointer/mouse-enter sequence. */
  hover(target: string): Promise<unknown>;
  /** Focus an element (ref or selector). */
  focus(target: string): Promise<unknown>;
  /** Double-click an element (ref or selector). */
  dblclick(target: string): Promise<unknown>;
  /** Check (true) / uncheck (false) a checkbox or radio (ref or selector). */
  setChecked(target: string, checked: boolean): Promise<unknown>;
  /** Scroll the page in a direction (up/down/left/right) by `px`. */
  scroll(direction: string, px: number): Promise<unknown>;
  /** Scroll an element (ref or selector) into view. */
  scrollIntoView(target: string): Promise<unknown>;
  /** get text|html|value|attr|count|box for a specific selector/ref. */
  getElement(what: string, selector: string, attr?: string): Promise<unknown>;
  /** is visible|enabled|checked for a selector/ref → boolean result. */
  isState(what: string, selector: string): Promise<unknown>;
  /** find <strategy> <query> <action> [value] — locate semantically + act. */
  find(strategy: string, query: string, action: string, value: string): Promise<unknown>;
  /** SPA client-side navigation via history.pushState. */
  pushState(url: string): Promise<unknown>;
  /** localStorage/sessionStorage: get all | get key | set k v | clear. */
  storage(area: string, op: string, key: string, value: string): Promise<unknown>;
  /** Resolve when the page URL matches a substring/regex (or timeout). */
  waitUrl(pattern: string, timeoutMs: number): Promise<unknown>;
  /** Resolve when a JS predicate returns truthy (or timeout). */
  waitFn(js: string, timeoutMs: number): Promise<unknown>;
  // ── Wait / synchronization ──
  /** Resolve when the pane finishes loading (or `timeoutMs` elapses). */
  waitLoad(timeoutMs: number): Promise<unknown>;
  /** Resolve when a CSS selector matches a visible element (or timeout). */
  waitSelector(selector: string, timeoutMs: number): Promise<unknown>;
  /** Resolve when the page's visible text contains a substring (or timeout). */
  waitText(text: string, timeoutMs: number): Promise<unknown>;
  /** Fixed delay. */
  sleep(ms: number): Promise<unknown>;
}

const registry = new Map<string, BrowserPaneApi>();

export function registerBrowser(containerId: string, api: BrowserPaneApi): void {
  registry.set(containerId, api);
}

export function unregisterBrowser(containerId: string): void {
  registry.delete(containerId);
}

export function getBrowser(containerId: string): BrowserPaneApi | undefined {
  return registry.get(containerId);
}
