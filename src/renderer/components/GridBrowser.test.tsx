import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GridBrowser } from './GridBrowser';
import { getBrowser } from './browserRegistry';
import type { BrowserShortcutAction } from '../../shared/browser-shortcuts';

// jsdom has no <webview>: React renders an inert unknown element, onto which we
// graft the guest methods GridBrowser calls and dispatch the guest's DOM events
// by hand. That's enough to drive the navigation/reload/shortcut wiring.

const TARGET = 'https://example.com/';
const GUEST_ID = 42;

type ShortcutCb = (webContentsId: number, action: BrowserShortcutAction) => void;
let shortcutCb: ShortcutCb | null = null;

function stubAPI(platform = 'darwin') {
  shortcutCb = null;
  Object.assign(window, {
    electronAPI: {
      platform,
      webviewPreloadUrl: '',
      onBrowserGuestShortcut: (cb: ShortcutCb) => {
        shortcutCb = cb;
        return () => { shortcutCb = null; };
      },
    },
  });
}

interface FakeGuest extends HTMLElement {
  history: { canBack: boolean; canForward: boolean };
  url: string;
  devtools: boolean;
  [k: string]: unknown;
}

function graftGuest(el: HTMLElement): FakeGuest {
  const wv = el as FakeGuest;
  wv.history = { canBack: false, canForward: false };
  wv.url = 'about:blank';
  wv.devtools = false;
  Object.assign(wv, {
    canGoBack: vi.fn(() => wv.history.canBack),
    canGoForward: vi.fn(() => wv.history.canForward),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    getURL: vi.fn(() => wv.url),
    getTitle: vi.fn(() => ''),
    clearHistory: vi.fn(() => { wv.history.canBack = false; }),
    setZoomFactor: vi.fn(),
    getWebContentsId: vi.fn(() => GUEST_ID),
    isDevToolsOpened: vi.fn(() => wv.devtools),
    openDevTools: vi.fn(() => { wv.devtools = true; }),
    closeDevTools: vi.fn(() => { wv.devtools = false; }),
    isLoading: vi.fn(() => false),
    focus: vi.fn(),
  });
  return wv;
}

function fire(wv: HTMLElement, type: string, props: Record<string, unknown> = {}) {
  act(() => {
    const ev = new Event(type);
    Object.assign(ev, props);
    wv.dispatchEvent(ev);
  });
}

function mount(url = TARGET, containerId = 'c1') {
  const onUrlChange = vi.fn();
  const onRequestFocus = vi.fn();
  const utils = render(
    <GridBrowser
      url={url}
      partition="persist:test"
      zoomLevel={13}
      containerId={containerId}
      onRequestFocus={onRequestFocus}
      onClose={() => {}}
      onSplitRight={() => {}}
      onSplitDown={() => {}}
      onUrlChange={onUrlChange}
    />,
  );
  const wv = graftGuest(utils.container.querySelector('webview') as HTMLElement);
  const address = screen.getByPlaceholderText(/search or enter address/i) as HTMLInputElement;
  return { ...utils, wv, address, onUrlChange, onRequestFocus };
}

// about:blank boots, then the pane's URL loads and commits.
function bootTo(wv: FakeGuest, url = TARGET) {
  fire(wv, 'did-start-navigation', { url: 'about:blank', isMainFrame: true, isInPlace: false });
  fire(wv, 'did-navigate', { url: 'about:blank' });
  fire(wv, 'dom-ready');
  fire(wv, 'did-start-navigation', { url, isMainFrame: true, isInPlace: false });
  wv.url = url;
  wv.history.canBack = true; // the about:blank entry, until cleared
  fire(wv, 'did-navigate', { url });
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stubAPI();
  // React warns that <webview> is not a known element in jsdom.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
});

describe('GridBrowser — initial load and history', () => {
  it('drops the about:blank boot entry so Back starts disabled, and never persists about:blank', () => {
    const { wv, onUrlChange, address } = mount();
    fire(wv, 'did-navigate', { url: 'about:blank' });
    expect(address.value).toBe(TARGET); // boot page doesn't blank the bar
    fire(wv, 'dom-ready');
    expect(wv.getAttribute('src')).toBe(TARGET);
    fire(wv, 'did-start-navigation', { url: TARGET, isMainFrame: true, isInPlace: false });
    wv.history.canBack = true;
    fire(wv, 'did-navigate', { url: TARGET });

    expect(wv.clearHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle(/^back/i)).toBeDisabled();
    expect(onUrlChange).toHaveBeenCalledWith(TARGET);
    expect(onUrlChange).not.toHaveBeenCalledWith('about:blank');

    // Later navigations keep their history.
    wv.history.canBack = true;
    fire(wv, 'did-navigate', { url: 'https://example.com/b' });
    expect(wv.clearHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle(/^back/i)).toBeEnabled();
  });

  it('back/forward buttons follow canGoBack/canGoForward and drive the guest', () => {
    const { wv } = mount();
    bootTo(wv);
    wv.history.canBack = true;
    wv.history.canForward = true;
    fire(wv, 'did-navigate-in-page', { url: `${TARGET}#x`, isMainFrame: true });
    fireEvent.click(screen.getByTitle(/^back/i));
    fireEvent.click(screen.getByTitle(/^forward/i));
    expect(wv.goBack).toHaveBeenCalledTimes(1);
    expect(wv.goForward).toHaveBeenCalledTimes(1);
  });
});

describe('GridBrowser — reload', () => {
  it('reload button reloads; while loading it stops', () => {
    const { wv } = mount();
    bootTo(wv);
    fireEvent.click(screen.getByTitle(/^reload/i));
    expect(wv.reload).toHaveBeenCalledTimes(1);
    fire(wv, 'did-start-loading');
    fireEvent.click(screen.getByTitle('Stop'));
    expect(wv.stop).toHaveBeenCalledTimes(1);
    fire(wv, 'did-stop-loading');
    expect(screen.getByTitle(/^reload/i)).toBeInTheDocument();
  });

  it('after a failed main-frame load, shows the error and Reload retries the failed URL', () => {
    const { wv, address } = mount();
    bootTo(wv);
    const bad = 'http://localhost:5173/';
    fire(wv, 'did-start-navigation', { url: bad, isMainFrame: true, isInPlace: false });
    fire(wv, 'did-fail-load', {
      isMainFrame: true, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: bad,
    });
    expect(screen.getByText(/couldn.t be loaded/i)).toBeInTheDocument();
    expect(screen.getByText('ERR_CONNECTION_REFUSED')).toBeInTheDocument();
    expect(address.value).toBe(bad);

    fireEvent.click(screen.getByTitle(/^reload/i));
    expect(wv.loadURL).toHaveBeenCalledWith(bad);
    expect(wv.reload).not.toHaveBeenCalled();

    // The agent bridge's reload takes the same path.
    getBrowser('c1')!.reload();
    expect(wv.loadURL).toHaveBeenCalledTimes(2);

    // Once a page commits, reload is a plain reload again and the error is gone.
    fire(wv, 'did-start-navigation', { url: bad, isMainFrame: true, isInPlace: false });
    fire(wv, 'did-navigate', { url: bad });
    expect(screen.queryByText(/couldn.t be loaded/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/^reload/i));
    expect(wv.reload).toHaveBeenCalledTimes(1);
  });

  it('going Back from a failed URL puts the page URL back in the bar', () => {
    const { wv, address } = mount();
    bootTo(wv);
    fire(wv, 'did-start-navigation', { url: 'http://nope.invalid/', isMainFrame: true, isInPlace: false });
    fire(wv, 'did-fail-load', {
      isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'http://nope.invalid/',
    });
    expect(address.value).toBe('http://nope.invalid/');
    fire(wv, 'did-start-navigation', { url: TARGET, isMainFrame: true, isInPlace: false });
    fire(wv, 'did-navigate', { url: TARGET });
    expect(address.value).toBe(TARGET);
  });

  it('ignores aborted loads, sub-frame failures and post-commit failures', () => {
    const { wv } = mount();
    bootTo(wv);
    fire(wv, 'did-start-navigation', { url: 'https://x.test/', isMainFrame: true, isInPlace: false });
    fire(wv, 'did-fail-load', { isMainFrame: true, errorCode: -3, errorDescription: 'ERR_ABORTED', validatedURL: 'https://x.test/' });
    fire(wv, 'did-fail-load', { isMainFrame: false, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: 'https://ads.test/' });
    fire(wv, 'did-navigate', { url: 'https://x.test/' });
    fire(wv, 'did-fail-load', { isMainFrame: true, errorCode: -101, errorDescription: 'ERR_CONNECTION_RESET', validatedURL: 'https://x.test/' });
    expect(screen.queryByText(/couldn.t be loaded/i)).not.toBeInTheDocument();
  });
});

describe('GridBrowser — shortcuts', () => {
  it('runs reserved chords main forwards for its own guest only', () => {
    const { wv } = mount();
    bootTo(wv);
    act(() => shortcutCb!(GUEST_ID + 1, 'reload'));
    expect(wv.reload).not.toHaveBeenCalled();
    act(() => shortcutCb!(GUEST_ID, 'reload'));
    act(() => shortcutCb!(GUEST_ID, 'hard-reload'));
    expect(wv.reload).toHaveBeenCalledTimes(1);
    expect(wv.reloadIgnoringCache).toHaveBeenCalledTimes(1);

    act(() => shortcutCb!(GUEST_ID, 'devtools'));
    expect(wv.openDevTools).toHaveBeenCalledTimes(1);
    act(() => shortcutCb!(GUEST_ID, 'devtools'));
    expect(wv.closeDevTools).toHaveBeenCalledTimes(1);

    act(() => shortcutCb!(GUEST_ID, 'focus-address'));
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/search or enter address/i));
  });

  it('acts on back/forward chords the guest preload forwards, never on reserved ones', () => {
    const { wv } = mount();
    bootTo(wv);
    wv.history.canBack = true;
    wv.history.canForward = true;
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-key', args: [{ key: '[', code: 'BracketLeft', meta: true }] });
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-key', args: [{ key: ']', code: 'BracketRight', meta: true }] });
    // ⌘← inside a text field moves the caret, not history.
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-key', args: [{ key: 'ArrowLeft', meta: true, editable: true }] });
    // Reserved chords are main's — a forwarded copy must not double-fire.
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-key', args: [{ key: 'r', code: 'KeyR', meta: true }] });
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-key', args: ['junk'] });
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-nav', args: ['back'] });
    fire(wv, 'ipc-message', { channel: 'splitgrid:guest-nav', args: ['sideways'] });
    expect(wv.goBack).toHaveBeenCalledTimes(2);
    expect(wv.goForward).toHaveBeenCalledTimes(1);
    expect(wv.reload).not.toHaveBeenCalled();
  });

  it('address bar: F5 reloads, ⌘L selects, Esc restores the page URL, Enter navigates', () => {
    const { wv, address } = mount();
    bootTo(wv);
    fireEvent.keyDown(address, { key: 'F5', code: 'F5' });
    expect(wv.reload).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(address, { key: 'l', code: 'KeyL', metaKey: true });
    expect(document.activeElement).toBe(address);

    fireEvent.change(address, { target: { value: 'half-typed' } });
    // A navigation while the user is editing doesn't clobber the edit.
    fire(wv, 'did-navigate-in-page', { url: `${TARGET}#route`, isMainFrame: true });
    expect(address.value).toBe('half-typed');
    fireEvent.keyDown(address, { key: 'Escape', code: 'Escape' });
    expect(address.value).toBe(`${TARGET}#route`);

    fireEvent.change(address, { target: { value: 'https://example.org/' } });
    fireEvent.keyDown(address, { key: 'Enter', code: 'Enter' });
    expect(wv.getAttribute('src')).toBe('https://example.org/');
    expect(wv.focus).toHaveBeenCalled();
  });

  it('Windows/Linux chords in the pane chrome', () => {
    stubAPI('win32');
    const { wv, address } = mount();
    bootTo(wv);
    wv.history.canBack = true;
    fire(wv, 'did-navigate-in-page', { url: `${TARGET}#a`, isMainFrame: true });
    fireEvent.keyDown(address, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(wv.goBack).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(address, { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true });
    expect(wv.openDevTools).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(address, { key: 'F5', code: 'F5', shiftKey: true });
    expect(wv.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });
});

describe('GridBrowser — DevTools button', () => {
  it('toggles the guest DevTools and reflects devtools-opened/closed', () => {
    const { wv } = mount();
    bootTo(wv);
    fireEvent.click(screen.getByTitle(/open devtools/i));
    expect(wv.openDevTools).toHaveBeenCalledTimes(1);
    fire(wv, 'devtools-opened');
    expect(screen.getByTitle(/close devtools/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/close devtools/i));
    expect(wv.closeDevTools).toHaveBeenCalledTimes(1);
    fire(wv, 'devtools-closed');
    expect(screen.getByTitle(/open devtools/i)).toBeInTheDocument();
  });
});
