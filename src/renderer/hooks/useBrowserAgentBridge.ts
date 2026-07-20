import { useEffect, useRef } from 'react';
import type { Workspace, ContainerContent } from '../../shared/types';
import { getBrowser } from '../components/browserRegistry';
import { parseArgv, MAX_WAIT_MS } from './browserArgv';
import { decideBrowserTarget } from './browserTargets';

const BROWSER_PARTITION = 'persist:browser';

// ─── Agent browser bridge (renderer side) ────────────────────────────────────
// Receives an agent's browser command (forwarded from main, keyed by reqId),
// resolves WHICH browser pane it targets using the ownership model, runs the
// MVP "verification loop" command against the live <webview> (via the browser
// registry), and replies. Ownership rule: an agent owns the browser it opened
// (browserOwnerTerminal === its $SPLITGRID_TERMINAL), so two agents in one
// workspace never collide; ambiguity is reported, never silently guessed.

interface BridgeDeps {
  workspaces: Workspace[];
  createBrowserContainer: (workspaceId: string, content: ContainerContent) => string;
  updateContainerContent: (containerId: string, content: ContainerContent) => void;
  removeContainer: (containerId: string) => void;
}

interface BrowserInfo {
  id: string;
  url: string;
  title: string;
  owner?: string;
}

type Reply = { ok: boolean; data?: Record<string, unknown>; error?: string };

// Coerce an automation script's reply into a record so we can spread it and read
// `ok`. Non-objects (shouldn't happen — scripts return JSON objects) become an error.
function asObj(v: unknown): { ok?: boolean } & Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : { ok: false, error: 'bad_result', raw: v };
}

const HELP = {
  usage: 'splitgrid-browser <command> [args]   (target = a snapshot ref "e1" OR a CSS selector)',
  commands: [
    'list                         — browsers in this workspace (with ownership)',
    'open|navigate|goto <url>     — focus/create a browser and load url',
    'close [all]                  — close your browser pane (or all you own)',
    'pushstate <url>              — SPA client-side navigation (history.pushState)',
    'back | forward | reload',
    'get url|title|text|html|console',
    'get text|html|value|attr|count|box <selector> [attr]  — read a specific element',
    'is visible|enabled|checked <selector>  — boolean state check',
    'screenshot [--full]          — PNG path (--full = whole page via CDP)',
    'pdf                          — export the page to a PDF, returns the path',
    'eval <js>                    — run JS in the page, returns the result',
    'snapshot [--viewport]        — tag interactive elements (incl. iframes), returns refs',
    'click | dblclick | hover | focus <target>',
    'fill <target> <text>         — set an input/textarea value',
    'type <text>                  — type into the focused field',
    'press <key> [target]         — real keypress (Enter, Tab, Control+a, …)',
    'select <target> <value>      — pick a <select> option',
    'check | uncheck <target>     — toggle a checkbox/radio',
    'scroll up|down|left|right [px] · scrollintoview <target>',
    'find <text|role|label|placeholder|testid|selector> <query> <action> [value]',
    'set viewport <w> <h> | set viewport reset  — device-size emulation',
    'wait load|selector <css>|text <substr>|url <pattern>|fn <js>|<ms>',
    'storage local|session [get [key] | set <k> <v> | clear]',
    'cookies [list|clear]         — cookies in this browser\'s session',
    'clipboard read|write [text]',
    'network start|list|clear|stop  — capture requests (status/type/failures)',
    '--target <surface>           — disambiguate when you own several browsers',
    '--timeout <ms>               — cap for wait selector/text/url/fn/load (default 10s)',
  ],
};

// Default wait cap (the max + the parser live in ./browserArgv so they can be
// unit-tested without React/the webview).
const DEFAULT_WAIT_MS = 10_000;

export function useBrowserAgentBridge(deps: BridgeDeps): void {
  // The IPC listener is registered once; read live state through a ref so it
  // always sees the current workspaces without re-subscribing.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const handle = async (payload: { reqId: string; terminal: string; argv: string[] }): Promise<void> => {
      const { reqId, terminal, argv } = payload;
      let reply: Reply;
      try {
        reply = await runCommand(depsRef.current, terminal, argv);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message || 'internal_error' };
      }
      window.electronAPI.sendBrowserResult({ reqId, ...reply });
    };

    const unsub = window.electronAPI.onBrowserCommand((payload) => { void handle(payload); });
    return unsub;
  }, []);
}

function browsersOf(ws: Workspace): Array<{ id: string; content: ContainerContent }> {
  return ws.containers.filter((c) => c.content.type === 'browser').map((c) => ({ id: c.id, content: c.content }));
}

function infoFor(id: string, content: ContainerContent): BrowserInfo {
  const live = getBrowser(id);
  return {
    id,
    url: (live?.getUrl() || content.browserUrl) ?? '',
    title: live?.getTitle() || content.label || 'Browser',
    owner: content.browserOwnerTerminal,
  };
}

async function runCommand(deps: BridgeDeps, terminal: string, argv: string[]): Promise<Reply> {
  const { workspaces, createBrowserContainer, updateContainerContent, removeContainer } = deps;
  const { positional, target, timeoutMs, viewport, full } = parseArgv(argv);
  const waitMs = timeoutMs ?? DEFAULT_WAIT_MS;
  const cmd = (positional[0] || '').toLowerCase();
  const rest = positional.slice(1);

  // Usage — workspace-independent, so handle before resolving the caller.
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '') {
    return { ok: true, data: { ...HELP } };
  }

  // Clipboard is global (no browser pane needed) — handle before pane resolution.
  if (cmd === 'clipboard') {
    const sub = (rest[0] || 'read').toLowerCase();
    if (sub === 'write') return { ok: true, data: { clipboardOp: 'write', clipboardText: rest.slice(1).join(' ') } };
    if (sub === 'read') return { ok: true, data: { clipboardOp: 'read' } };
    return { ok: false, error: 'unknown_clipboard', data: { message: 'clipboard read|write [text]' } };
  }

  // Caller's workspace = the one holding its terminal. Main routes the command to
  // the window that OWNS this terminal, so it resolves here; if it genuinely
  // can't be located we refuse rather than guess a workspace — guessing the sole
  // workspace could drive a browser the agent doesn't own (e.g. wrong window).
  const callerWs =
    workspaces.find((ws) => ws.containers.some((c) => c.content.terminalId === terminal)) ?? null;

  if (!callerWs) return { ok: false, error: 'unknown_terminal', data: { message: 'cannot locate the calling terminal\'s workspace' } };

  const list = browsersOf(callerWs);

  // `list` — enumerate this workspace's browsers (with ownership).
  if (cmd === 'list') {
    return {
      ok: true,
      data: {
        browsers: list.map((b) => {
          const info = infoFor(b.id, b.content);
          return { ...info, mine: info.owner === terminal };
        }),
      },
    };
  }

  // open / navigate — ensure a target browser, navigate to the url, auto-create
  // one when the workspace has none (or none owned/claimable).
  if (cmd === 'open' || cmd === 'navigate' || cmd === 'goto') {
    const url = rest[0];
    if (!url) return { ok: false, error: 'missing_url', data: { message: `usage: ${cmd} <url>` } };

    const resolved = resolveExistingTarget(list, terminal, target);
    if (resolved.id) {
      // Reuse: navigate the live pane + persist the url.
      const api = getBrowser(resolved.id);
      if (api) api.navigate(url);
      const c = callerWs.containers.find((x) => x.id === resolved.id);
      if (c && c.content.type === 'browser') {
        updateContainerContent(resolved.id, { ...c.content, browserUrl: url, ...(resolved.claim ? { browserOwnerTerminal: terminal } : {}) });
      }
      return { ok: true, data: { surface: resolved.id, url, reused: true } };
    }
    if (resolved.error && cmd !== 'open' && resolved.kind === 'ambiguous') return resolved.error;

    // Create a new browser pane owned by this agent.
    const id = createBrowserContainer(callerWs.id, {
      type: 'browser',
      browserUrl: url,
      browserPartition: BROWSER_PARTITION,
      browserOwnerTerminal: terminal,
      label: 'Browser',
    });
    return { ok: true, data: { surface: id, url, created: true } };
  }

  // close — remove a browser pane. `close all` closes every browser this terminal
  // owns; otherwise close the resolved target (explicit --target or the owned one).
  // No live `api` needed — the pane may already be tearing down.
  if (cmd === 'close' || cmd === 'quit') {
    if ((rest[0] || '').toLowerCase() === 'all') {
      const mine = list.filter((b) => b.content.browserOwnerTerminal === terminal);
      mine.forEach((b) => removeContainer(b.id));
      return { ok: true, data: { closed: mine.map((b) => b.id), count: mine.length } };
    }
    const r = resolveExistingTarget(list, terminal, target);
    if (!r.id) return r.error ?? { ok: false, error: 'no_browser', data: { message: 'no browser to close; run: list' } };
    removeContainer(r.id);
    return { ok: true, data: { surface: r.id, closed: true } };
  }

  // All remaining commands act on an existing pane — resolve it strictly.
  const resolved = resolveExistingTarget(list, terminal, target);
  if (!resolved.id) {
    return resolved.error ?? { ok: false, error: 'no_browser', data: { message: 'no browser in this workspace; run: open <url>' } };
  }
  if (resolved.claim) {
    const c = callerWs.containers.find((x) => x.id === resolved.id);
    if (c && c.content.type === 'browser') updateContainerContent(resolved.id, { ...c.content, browserOwnerTerminal: terminal });
  }

  const api = getBrowser(resolved.id);
  if (!api) return { ok: false, error: 'browser_not_ready', data: { surface: resolved.id } };
  const surface = resolved.id;

  switch (cmd) {
    case 'back': api.back(); return { ok: true, data: { surface } };
    case 'forward': api.forward(); return { ok: true, data: { surface } };
    case 'reload': api.reload(); return { ok: true, data: { surface } };
    case 'screenshot': {
      // Captured in the main process from the guest webContents id (renderer-side
      // <webview>.capturePage() can hard-crash the renderer).
      const id = api.getWebContentsId();
      if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
      return { ok: true, data: { surface, captureWebContentsId: id, ...(full ? { fullPage: true } : {}) } };
    }
    case 'eval': {
      const js = rest.join(' ');
      if (!js) return { ok: false, error: 'missing_js', data: { message: 'usage: eval <js>' } };
      const result = await api.eval(js);
      return { ok: true, data: { surface, result: result === undefined ? null : result } };
    }
    case 'get': {
      const what = (rest[0] || '').toLowerCase();
      const sel = rest[1];
      switch (what) {
        case 'url': return { ok: true, data: { surface, url: api.getUrl() } };
        case 'title': return { ok: true, data: { surface, title: api.getTitle() } };
        // text/html: whole page by default, or a specific selector/ref if given.
        case 'text': return sel
          ? { ok: true, data: { surface, ...asObj(await api.getElement('text', sel)) } }
          : { ok: true, data: { surface, text: await api.getText() } };
        case 'html': return sel
          ? { ok: true, data: { surface, ...asObj(await api.getElement('html', sel)) } }
          : { ok: true, data: { surface, html: await api.getHtml() } };
        case 'value': case 'count': case 'box':
          if (!sel) return { ok: false, error: 'missing_selector', data: { message: `usage: get ${what} <selector>` } };
          return { ok: true, data: { surface, ...asObj(await api.getElement(what, sel)) } };
        case 'attr': {
          if (!sel || !rest[2]) return { ok: false, error: 'missing_args', data: { message: 'usage: get attr <selector> <attribute>' } };
          return { ok: true, data: { surface, ...asObj(await api.getElement('attr', sel, rest[2])) } };
        }
        case 'console': return { ok: true, data: { surface, console: api.getConsole() } };
        case 'network': {
          const id = api.getWebContentsId();
          if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
          return { ok: true, data: { surface, networkOp: 'list', netWebContentsId: id } };
        }
        default: return { ok: false, error: 'unknown_get', data: { message: 'get url|title|text|html|value|attr|count|box|console|network' } };
      }
    }
    case 'is': {
      const what = (rest[0] || '').toLowerCase();
      const sel = rest[1];
      if (!['visible', 'enabled', 'checked'].includes(what) || !sel)
        return { ok: false, error: 'usage', data: { message: 'is visible|enabled|checked <selector>' } };
      return { ok: true, data: { surface, ...asObj(await api.isState(what, sel)) } };
    }
    case 'hover': {
      if (!rest[0]) return { ok: false, error: 'missing_target', data: { message: 'usage: hover <target>' } };
      return { ok: true, data: { surface, ...asObj(await api.hover(rest[0])) } };
    }
    case 'focus': {
      if (!rest[0]) return { ok: false, error: 'missing_target', data: { message: 'usage: focus <target>' } };
      return { ok: true, data: { surface, ...asObj(await api.focus(rest[0])) } };
    }
    case 'dblclick': case 'doubleclick': {
      if (!rest[0]) return { ok: false, error: 'missing_target', data: { message: 'usage: dblclick <target>' } };
      return { ok: true, data: { surface, ...asObj(await api.dblclick(rest[0])) } };
    }
    case 'check': case 'uncheck': {
      if (!rest[0]) return { ok: false, error: 'missing_target', data: { message: `usage: ${cmd} <target>` } };
      return { ok: true, data: { surface, ...asObj(await api.setChecked(rest[0], cmd === 'check')) } };
    }
    case 'scroll': {
      const dir = (rest[0] || '').toLowerCase();
      const px = Number(rest[1]);
      return { ok: true, data: { surface, ...asObj(await api.scroll(dir, Number.isFinite(px) && px > 0 ? Math.floor(px) : 400)) } };
    }
    case 'scrollintoview': case 'scrollinto': {
      if (!rest[0]) return { ok: false, error: 'missing_target', data: { message: 'usage: scrollintoview <target>' } };
      return { ok: true, data: { surface, ...asObj(await api.scrollIntoView(rest[0])) } };
    }
    case 'press': {
      const key = rest[0];
      if (!key) return { ok: false, error: 'missing_key', data: { message: 'usage: press <key> [target]  e.g. press Enter, press Control+a' } };
      // Optional target: focus it first (in the page) so the key lands there.
      if (rest[1]) await api.focus(rest[1]);
      const id = api.getWebContentsId();
      if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
      return { ok: true, data: { surface, inputWebContentsId: id, inputKey: key } };
    }
    case 'find': {
      const strategy = (rest[0] || '').toLowerCase();
      const query = rest[1];
      const action = (rest[2] || 'click').toLowerCase();
      const value = rest.slice(3).join(' ');
      if (!['text', 'role', 'label', 'placeholder', 'testid', 'selector'].includes(strategy) || !query)
        return { ok: false, error: 'usage', data: { message: 'find <text|role|label|placeholder|testid|selector> <query> <action> [value]' } };
      return { ok: true, data: { surface, ...asObj(await api.find(strategy, query, action, value)) } };
    }
    case 'pushstate': {
      if (!rest[0]) return { ok: false, error: 'missing_url', data: { message: 'usage: pushstate <url>' } };
      return { ok: true, data: { surface, ...asObj(await api.pushState(rest[0])) } };
    }
    case 'storage': {
      const area = (rest[0] || '').toLowerCase();
      if (area !== 'local' && area !== 'session')
        return { ok: false, error: 'usage', data: { message: 'storage local|session [get [key] | set <k> <v> | clear]' } };
      const op = (rest[1] || 'get').toLowerCase();
      const key = op === 'get' ? (rest[2] || '') : rest[2] || '';
      const value = op === 'set' ? rest.slice(3).join(' ') : '';
      if (op === 'set' && (!key)) return { ok: false, error: 'missing_args', data: { message: 'usage: storage <area> set <key> <value>' } };
      return { ok: true, data: { surface, ...asObj(await api.storage(area, op, key, value)) } };
    }
    case 'cookies': {
      const sub = (rest[0] || 'list').toLowerCase();
      if (sub !== 'list' && sub !== 'clear')
        return { ok: false, error: 'usage', data: { message: 'cookies [list|clear]' } };
      const id = api.getWebContentsId();
      if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
      return { ok: true, data: { surface, cookieOp: sub, cookieWebContentsId: id } };
    }
    case 'pdf': {
      const id = api.getWebContentsId();
      if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
      return { ok: true, data: { surface, pdfWebContentsId: id } };
    }
    case 'set': {
      const what = (rest[0] || '').toLowerCase();
      if (what !== 'viewport')
        return { ok: false, error: 'unknown_set', data: { message: 'set viewport <w> <h> | set viewport reset' } };
      const id = api.getWebContentsId();
      if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
      if ((rest[1] || '').toLowerCase() === 'reset')
        return { ok: true, data: { surface, viewportWebContentsId: id, viewportReset: true } };
      const w = Number(rest[1]); const h = Number(rest[2]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
        return { ok: false, error: 'bad_args', data: { message: 'usage: set viewport <width> <height>' } };
      return { ok: true, data: { surface, viewportWebContentsId: id, viewportWidth: Math.floor(w), viewportHeight: Math.floor(h) } };
    }
    // Interactive automation. snapshot tags elements with refs (e1, e2, …); the
    // action commands resolve an element by that ref. Inner result carries `ok`.
    case 'snapshot': {
      const r = asObj(await api.snapshot({ viewportOnly: viewport }));
      return { ok: r.ok !== false, data: { surface, ...r } };
    }
    case 'click': {
      const target = rest[0];
      if (!target) return { ok: false, error: 'missing_target', data: { message: 'usage: click <target>  (a snapshot ref or a CSS selector)' } };
      const r = asObj(await api.click(target));
      return { ok: r.ok !== false, data: { surface, ...r } };
    }
    case 'fill': {
      const target = rest[0];
      const text = rest.slice(1).join(' ');
      if (!target) return { ok: false, error: 'missing_target', data: { message: 'usage: fill <target> <text>  (target = ref or CSS selector)' } };
      const r = asObj(await api.fill(target, text));
      return { ok: r.ok !== false, data: { surface, ...r } };
    }
    case 'type': {
      const text = rest.join(' ');
      if (!text) return { ok: false, error: 'missing_text', data: { message: 'usage: type <text>  (types into the focused field)' } };
      const r = asObj(await api.type(text));
      return { ok: r.ok !== false, data: { surface, ...r } };
    }
    case 'select': {
      const target = rest[0];
      const value = rest.slice(1).join(' ');
      if (!target || !value) return { ok: false, error: 'missing_args', data: { message: 'usage: select <target> <value>  (target = ref or CSS selector)' } };
      const r = asObj(await api.selectOption(target, value));
      return { ok: r.ok !== false, data: { surface, ...r } };
    }
    // wait load | wait selector <css> | wait text <substr> | wait <ms>
    // Optional --timeout <ms> (default 10s, capped 30s) for the polling waits.
    case 'wait': {
      const what = (rest[0] || '').toLowerCase();
      if (what === 'load' || what === 'navigation') {
        const r = asObj(await api.waitLoad(waitMs));
        return { ok: r.ok !== false, data: { surface, ...r } };
      }
      if (what === 'selector') {
        const sel = rest.slice(1).join(' ');
        if (!sel) return { ok: false, error: 'missing_selector', data: { message: 'usage: wait selector <css> [--timeout ms]' } };
        const r = asObj(await api.waitSelector(sel, waitMs));
        return { ok: r.ok !== false, data: { surface, ...r } };
      }
      if (what === 'text') {
        const text = rest.slice(1).join(' ');
        if (!text) return { ok: false, error: 'missing_text', data: { message: 'usage: wait text <substring> [--timeout ms]' } };
        const r = asObj(await api.waitText(text, waitMs));
        return { ok: r.ok !== false, data: { surface, ...r } };
      }
      if (what === 'url') {
        const pattern = rest.slice(1).join(' ');
        if (!pattern) return { ok: false, error: 'missing_pattern', data: { message: 'usage: wait url <substring|regex> [--timeout ms]' } };
        const r = asObj(await api.waitUrl(pattern, waitMs));
        return { ok: r.ok !== false, data: { surface, ...r } };
      }
      if (what === 'fn' || what === 'function') {
        const js = rest.slice(1).join(' ');
        if (!js) return { ok: false, error: 'missing_fn', data: { message: 'usage: wait fn <js-expression> [--timeout ms]' } };
        const r = asObj(await api.waitFn(js, waitMs));
        return { ok: r.ok !== false, data: { surface, ...r } };
      }
      // Bare number → fixed sleep (capped at MAX_WAIT_MS).
      const ms = Number(what);
      if (Number.isFinite(ms) && ms >= 0) {
        const r = asObj(await api.sleep(Math.min(MAX_WAIT_MS, Math.floor(ms))));
        return { ok: r.ok !== false, data: { surface, ...r } };
      }
      return { ok: false, error: 'unknown_wait', data: { message: 'wait load | wait selector <css> | wait text <substr> | wait <ms>' } };
    }
    // network [start|stop|clear|list] — CDP capture handled in main; we just
    // resolve the pane and hand its guest webContents id to the bridge.
    case 'network': {
      const sub = (rest[0] || 'list').toLowerCase();
      if (!['start', 'stop', 'clear', 'list'].includes(sub)) {
        return { ok: false, error: 'unknown_network', data: { message: 'network start|stop|clear|list' } };
      }
      const id = api.getWebContentsId();
      if (id < 0) return { ok: false, error: 'browser_not_ready', data: { surface } };
      return { ok: true, data: { surface, networkOp: sub, netWebContentsId: id } };
    }
    default:
      return { ok: false, error: 'unknown_command', data: { message: `unknown command: ${cmd}` } };
  }
}

// (helpers below)

interface ResolveResult {
  id?: string;
  claim?: boolean; // newly-claimed an unowned pane
  kind?: 'ambiguous' | 'none';
  error?: Reply;
}

// Resolve which EXISTING browser a command targets, per the ownership rule. The
// DECISION (own=1 / own>1 / claim-unowned / none) is the pure decideBrowserTarget;
// here we only attach presentation (live url/title via infoFor) to the errors.
function resolveExistingTarget(
  list: Array<{ id: string; content: ContainerContent }>,
  terminal: string,
  explicitTarget?: string,
): ResolveResult {
  const byId = (id: string) => list.find((b) => b.id === id)!;
  const infos = (ids: string[]) => ids.map((id) => { const b = byId(id); return infoFor(b.id, b.content); });
  const decision = decideBrowserTarget(
    list.map((b) => ({ id: b.id, ownerTerminal: b.content.browserOwnerTerminal })),
    terminal,
    explicitTarget,
  );
  switch (decision.kind) {
    case 'resolved':
      return { id: decision.id, claim: decision.claim };
    case 'not_found':
      return { kind: 'none', error: { ok: false, error: 'target_not_found', data: { target: explicitTarget } } };
    case 'ambiguous':
      return {
        kind: 'ambiguous',
        error: {
          ok: false,
          error: 'ambiguous_target',
          data: { message: 'you own multiple browsers here — pass --target <surface>', browsers: infos(decision.mine) },
        },
      };
    case 'none':
      return {
        kind: 'none',
        error: {
          ok: false,
          error: 'no_owned_target',
          data: { message: 'no browser you own here — pass --target <surface> or run: open <url>', browsers: infos(decision.all) },
        },
      };
  }
}
