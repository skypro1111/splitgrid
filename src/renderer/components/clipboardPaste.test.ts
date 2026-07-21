import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pasteClipboardIntoTerminal, type PasteSessionMeta } from './clipboardPaste';

// Minimal electronAPI surface the paste path touches.
function stubAPI(over: {
  platform?: string;
  files?: string[];
  text?: string;
  hasImage?: boolean;
  tempPath?: string | null;
}) {
  const api = {
    platform: over.platform ?? 'win32',
    clipboardReadFilePaths: vi.fn(async () => over.files ?? []),
    clipboardReadText: vi.fn(async () => over.text ?? ''),
    clipboardHasImage: vi.fn(async () => over.hasImage ?? false),
    clipboardSaveImageTemp: vi.fn(async () => over.tempPath ?? null),
  };
  (globalThis as unknown as { window: unknown }).window = { electronAPI: api };
  return api;
}

const LOCAL: PasteSessionMeta = { type: 'local' };

async function paste(session: PasteSessionMeta = LOCAL) {
  const terminal = { paste: vi.fn() };
  const sent: string[] = [];
  pasteClipboardIntoTerminal(terminal, (d) => sent.push(d), session);
  // The helper runs its work in a floating promise; let the microtasks drain.
  await new Promise((r) => setTimeout(r, 0));
  return { terminal, sent };
}

describe('pasteClipboardIntoTerminal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('types the paths of files copied in the file manager', async () => {
    stubAPI({ files: ['C:\\Users\\me\\shot 1.png'], text: '' });
    const { sent, terminal } = await paste();
    expect(sent).toEqual(["'C:\\Users\\me\\shot 1.png' "]);
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('prefers copied files over clipboard text', async () => {
    stubAPI({ files: ['/tmp/a.png'], text: 'a.png' });
    const { sent, terminal } = await paste();
    expect(sent).toEqual(['/tmp/a.png ']);
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('pastes plain text and never reads the image', async () => {
    const api = stubAPI({ text: 'echo hi' });
    const { terminal, sent } = await paste();
    expect(terminal.paste).toHaveBeenCalledWith('echo hi');
    expect(sent).toEqual([]);
    expect(api.clipboardHasImage).not.toHaveBeenCalled();
  });

  it('prefers the image when the text is only the URL a browser attached', async () => {
    stubAPI({ text: 'https://example.com/cat.png', hasImage: true, tempPath: '/tmp/paste-1.png' });
    const { terminal, sent } = await paste();
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(sent).toEqual(['/tmp/paste-1.png ']);
  });

  it('keeps the URL when there is no image behind it', async () => {
    stubAPI({ text: 'https://example.com/cat.png', hasImage: false });
    const { terminal, sent } = await paste();
    expect(terminal.paste).toHaveBeenCalledWith('https://example.com/cat.png');
    expect(sent).toEqual([]);
  });

  it('pastes text over SSH rather than a Ctrl-V the remote CLI cannot use', async () => {
    stubAPI({ text: 'https://example.com/cat.png', hasImage: true });
    const { terminal, sent } = await paste({ type: 'ssh' });
    expect(terminal.paste).toHaveBeenCalledWith('https://example.com/cat.png');
    expect(sent).toEqual([]);
  });

  it('forwards Ctrl-V on macOS so the CLI reads the native pasteboard', async () => {
    stubAPI({ platform: 'darwin', text: '', hasImage: true });
    const { sent } = await paste();
    expect(sent).toEqual(['\u0016']);
  });

  it('translates the temp image path for a WSL session', async () => {
    const api = stubAPI({ text: '', hasImage: true, tempPath: '/mnt/c/tmp/paste-1.png' });
    const { sent } = await paste({ type: 'local', shell: 'wsl:Ubuntu' });
    expect(api.clipboardSaveImageTemp).toHaveBeenCalledWith('wsl');
    expect(sent).toEqual(['/mnt/c/tmp/paste-1.png ']);
  });
});
