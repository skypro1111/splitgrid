import { describe, it, expect } from 'vitest';
import { routeTabCommand, NOT_SUPPORTED_ON_TAB } from './agent-browser-tab-route';

// The CLI vocabulary is shared by both browser surfaces, so the ONLY thing
// standing between an agent's argv and a browser tab is this translation. Two
// properties matter: the supported ops map exactly onto the phase-0 ExtCommand
// vocabulary, and every other command fails LOUDLY (an agent that gets
// {ok:true} for a `click` it never performed would build on a lie).

describe('routeTabCommand — supported ops', () => {
  it('maps navigation commands', () => {
    for (const cmd of ['open', 'navigate', 'goto']) {
      expect(routeTabCommand([cmd, 'http://localhost:3000'])).toEqual({
        kind: 'command',
        command: { op: 'navigate', url: 'http://localhost:3000' },
        extra: { url: 'http://localhost:3000' },
      });
    }
    expect(routeTabCommand(['back'])).toEqual({ kind: 'command', command: { op: 'back' } });
    expect(routeTabCommand(['forward'])).toEqual({ kind: 'command', command: { op: 'forward' } });
    expect(routeTabCommand(['reload'])).toEqual({ kind: 'command', command: { op: 'reload' } });
  });

  it('maps get url|title to one info round-trip carrying the requested field', () => {
    expect(routeTabCommand(['get', 'url'])).toEqual({ kind: 'command', command: { op: 'info' }, infoField: 'url' });
    expect(routeTabCommand(['get', 'title'])).toEqual({ kind: 'command', command: { op: 'info' }, infoField: 'title' });
  });

  it('maps whole-page get text|html', () => {
    expect(routeTabCommand(['get', 'text'])).toEqual({ kind: 'command', command: { op: 'text' } });
    expect(routeTabCommand(['get', 'html'])).toEqual({ kind: 'command', command: { op: 'html' } });
  });

  it('maps eval, joining the remaining positionals into one script', () => {
    expect(routeTabCommand(['eval', 'document.title', '+', '"!"'])).toEqual({
      kind: 'command',
      command: { op: 'eval', js: 'document.title + "!"' },
    });
  });

  it('maps screenshot, honouring --full/--fullpage', () => {
    expect(routeTabCommand(['screenshot'])).toEqual({ kind: 'command', command: { op: 'screenshot' } });
    expect(routeTabCommand(['screenshot', '--full'])).toEqual({ kind: 'command', command: { op: 'screenshot', fullPage: true } });
    expect(routeTabCommand(['screenshot', '--fullpage'])).toEqual({ kind: 'command', command: { op: 'screenshot', fullPage: true } });
  });

  it('maps close/quit to release (hand the tab back, do not destroy it)', () => {
    expect(routeTabCommand(['close'])).toEqual({ kind: 'command', command: { op: 'release' }, extra: { closed: true } });
    expect(routeTabCommand(['quit'])).toEqual({ kind: 'command', command: { op: 'release' }, extra: { closed: true } });
  });

  it('ignores the flags it does not need (--target itself, --timeout)', () => {
    expect(routeTabCommand(['get', 'title', '--target', 'tab:c1.842', '--timeout', '2000'])).toEqual({
      kind: 'command',
      command: { op: 'info' },
      infoField: 'title',
    });
  });
});

describe('routeTabCommand — surface-independent commands stay with the renderer', () => {
  it.each([['list'], ['help'], ['--help'], ['-h'], ['clipboard'], ['']])('%s', (cmd) => {
    expect(routeTabCommand([cmd])).toEqual({ kind: 'renderer' });
  });
});

describe('routeTabCommand — unsupported commands fail loudly', () => {
  const paneOnly = [
    'snapshot', 'click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'focus',
    'dblclick', 'press', 'find', 'wait', 'network', 'cookies', 'storage', 'pdf', 'is',
    'set', 'scroll', 'scrollintoview', 'pushstate',
  ];

  it.each(paneOnly)('%s → not_supported_on_tab, naming the command', (cmd) => {
    const r = routeTabCommand([cmd, 'e1']);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.error).toBe(NOT_SUPPORTED_ON_TAB);
    expect(r.message).toContain(`"${cmd}"`);
    expect(r.message).toContain('browser pane');
  });

  it('rejects element-scoped and pane-only get sub-commands', () => {
    for (const argv of [['get', 'text', '#app'], ['get', 'html', '#app'], ['get', 'console'], ['get', 'value', '#email'], ['get', 'network']]) {
      const r = routeTabCommand(argv);
      expect(r.kind).toBe('error');
      if (r.kind === 'error') expect(r.error).toBe(NOT_SUPPORTED_ON_TAB);
    }
  });

  it('rejects `close all` rather than guessing which tabs to release', () => {
    const r = routeTabCommand(['close', 'all']);
    expect(r).toMatchObject({ kind: 'error', error: NOT_SUPPORTED_ON_TAB });
  });

  it('reports usage errors distinctly from unsupported ones', () => {
    expect(routeTabCommand(['open'])).toMatchObject({ kind: 'error', error: 'missing_url' });
    expect(routeTabCommand(['eval'])).toMatchObject({ kind: 'error', error: 'missing_js' });
    expect(routeTabCommand(['get'])).toMatchObject({ kind: 'error', error: 'unknown_get' });
  });
});
