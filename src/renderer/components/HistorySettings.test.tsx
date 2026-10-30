import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HistorySettings, formatBytes, formatMinutes } from './HistorySettings';
import type { HistoryActionResult, HistoryEstimate, HistoryStatus } from '../../shared/types';

afterEach(() => cleanup());

const MB = 1024 * 1024;
const GB = 1024 * MB;

const OFF: HistoryStatus = { enabled: false, progress: { state: 'off' }, workspaces: [] };
const ESTIMATE: HistoryEstimate = {
  transcriptFiles: 1234,
  transcriptBytes: 2 * GB,
  downloadBytes: 420 * MB,
  diskBytes: 1.5 * GB,
  firstImportMinutes: 25,
};

// The history* round-trips the block makes. `push` stands in for main's
// history:status broadcast.
function stubAPI(opts: { status?: HistoryStatus; enable?: HistoryActionResult } = {}) {
  let listener: ((s: HistoryStatus) => void) | null = null;
  const api = {
    historyGetStatus: vi.fn(async () => opts.status ?? OFF),
    historyEstimate: vi.fn(async () => ESTIMATE),
    historyEnable: vi.fn(async (): Promise<HistoryActionResult> => opts.enable ?? { ok: true }),
    historyDisable: vi.fn<(o: { deleteData: boolean }) => Promise<HistoryActionResult>>(async () => ({ ok: true })),
    historyPause: vi.fn(async () => undefined),
    historyResume: vi.fn(async () => undefined),
    onHistoryStatus: vi.fn((cb: (s: HistoryStatus) => void) => { listener = cb; return () => { listener = null; }; }),
  };
  Object.assign(window, { electronAPI: api });
  const push = (s: HistoryStatus) => act(() => { listener?.(s); });
  return { api, push };
}

const toggle = () => screen.getByRole('switch', { name: 'Enable workspace history' });

describe('HistorySettings consent', () => {
  it('shows what enabling costs before anything is enabled', async () => {
    const { api } = stubAPI();
    render(<HistorySettings enabled={false} integrations />);
    expect(api.historyEstimate).not.toHaveBeenCalled();

    fireEvent.click(toggle());
    expect(await screen.findByText(/Found 1,234 transcript files \(2\.0 GB\)/)).toBeInTheDocument();
    expect(screen.getByText(/420 MB once/)).toBeInTheDocument();
    expect(screen.getByText(/about 1\.5 GB/)).toBeInTheDocument();
    expect(screen.getByText(/about 25 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/Everything stays on this machine/)).toBeInTheDocument();
    // Showing the estimate is not consent: the switch is still off.
    expect(api.historyEnable).not.toHaveBeenCalled();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it('calls enable only after the confirm button, never on Cancel', async () => {
    const { api } = stubAPI();
    const { rerender } = render(<HistorySettings enabled={false} integrations />);

    fireEvent.click(toggle());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Download and enable' })).toBeNull();
    expect(api.historyEnable).not.toHaveBeenCalled();

    fireEvent.click(toggle());
    fireEvent.click(await screen.findByRole('button', { name: 'Download and enable' }));
    expect(api.historyEnable).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    // Main's app-settings broadcast is what lands the persisted consent.
    rerender(<HistorySettings enabled integrations />);
    expect(await screen.findByText(/No workspace sessions indexed yet/)).toBeInTheDocument();
  });

  it('shows the error and stays off when enable fails', async () => {
    stubAPI({ enable: { ok: false, error: 'Model checksum mismatch' } });
    render(<HistorySettings enabled={false} integrations />);

    fireEvent.click(toggle());
    fireEvent.click(await screen.findByRole('button', { name: 'Download and enable' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Model checksum mismatch');
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Remove downloaded files' })).toBeInTheDocument();
  });

  it('notes that agents need Agent integrations', () => {
    stubAPI();
    const { rerender } = render(<HistorySettings enabled={false} integrations={false} />);
    expect(screen.getByText(/Agent integrations is off/)).toBeInTheDocument();
    rerender(<HistorySettings enabled={false} integrations />);
    expect(screen.queryByText(/Agent integrations is off/)).toBeNull();
  });
});

describe('HistorySettings while on', () => {
  it('shows install and indexing progress with Pause / Resume', async () => {
    const { api, push } = stubAPI();
    render(<HistorySettings enabled={false} integrations />);

    push({ ...OFF, progress: { state: 'installing', downloadedBytes: 100 * MB, totalBytes: 400 * MB } });
    expect(screen.getByText(/Downloading the runtime and model… 100 MB of 400 MB/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(api.historyPause).toHaveBeenCalledTimes(1);

    push({ enabled: true, progress: { state: 'paused', embeddedChunks: 300, totalChunks: 1200 }, workspaces: [] });
    expect(screen.getByText(/Indexing paused — 300 of 1,200 chunks embedded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(api.historyResume).toHaveBeenCalledTimes(1);
  });

  it('lists per-workspace stats', async () => {
    stubAPI({
      status: {
        enabled: true,
        progress: { state: 'idle' },
        workspaces: [{ workspaceId: 'ws-1', sessions: 12, chunks: 340, embeddedChunks: 340, dbBytes: 3 * MB }],
      },
    });
    render(<HistorySettings enabled integrations workspaceNames={{ 'ws-1': 'swapit' }} />);
    expect(await screen.findByText('swapit')).toBeInTheDocument();
    expect(screen.getByText(/12 sessions · 340 chunks · 3\.0 MB/)).toBeInTheDocument();
  });

  it('asks before turning off, suggesting delete; either choice reaches disable', async () => {
    const { api } = stubAPI();
    const { unmount } = render(<HistorySettings enabled integrations />);

    fireEvent.click(toggle());
    expect(api.historyDisable).not.toHaveBeenCalled();
    const del = screen.getByRole('button', { name: 'Turn off and delete data' });
    expect(del).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off, keep data' }));
    expect(api.historyDisable).toHaveBeenCalledWith({ deleteData: false });
    unmount();

    render(<HistorySettings enabled integrations />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Turn off and delete data' }));
    expect(api.historyDisable).toHaveBeenLastCalledWith({ deleteData: true });
  });

  // A renderer reloaded against an older preload has none of the history*
  // methods; one TypeError out of a click handler takes the whole app down.
  it('survives a preload without the history methods', () => {
    Object.assign(window, { electronAPI: {} });
    render(<HistorySettings enabled={false} integrations />);
    fireEvent.click(toggle());
    expect(screen.getByRole('alert')).toHaveTextContent(/restart SplitGrid/);
  });
});

describe('history formatting', () => {
  it('formats bytes and minutes for people', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(310 * MB)).toBe('310 MB');
    expect(formatBytes(1.25 * GB)).toBe('1.3 GB');
    expect(formatMinutes(0.4)).toBe('under a minute');
    expect(formatMinutes(1)).toBe('about 1 minute');
    expect(formatMinutes(25.4)).toBe('about 25 minutes');
    expect(formatMinutes(130)).toBe('about 2 h 10 min');
    expect(formatMinutes(120)).toBe('about 2 h');
  });
});
