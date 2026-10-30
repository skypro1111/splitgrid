import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HistoryDistillSettings, formatTokens, formatUsd } from './HistoryDistillSettings';
import { HistorySettings } from './HistorySettings';
import type { HistoryActionResult, HistoryDistillEstimate, HistoryDistillStatus, HistoryStatus } from '../../shared/types';

afterEach(() => cleanup());

const ESTIMATE: HistoryDistillEstimate = {
  model: 'Claude Haiku 5.5',
  priceInputPerMTok: 0.1,
  priceOutputPerMTok: 0.5,
  pendingGroups: 42,
  pendingInputTokens: 2_400_000,
  pendingOutputTokens: 63_000,
  backlogUsd: 0.2715,
  unsettledGroups: 2,
  monthlyGroups: 12,
  monthlyInputTokens: 700_000,
  monthlyOutputTokens: 18_000,
  monthlyUsd: 0.079,
  spentUsd: 0,
  notes: 0,
};

const STATUS: HistoryDistillStatus = {
  enabled: true, state: 'running', groupsDistilled: 10, groupsPending: 30, groupsFailed: 0, groupsUnsettled: 1, notes: 37, spentUsd: 0.0123,
};

function stubAPI(over: Record<string, unknown> = {}) {
  const api = {
    historyDistillEstimate: vi.fn(async () => ESTIMATE),
    historyDistillEnable: vi.fn(async (): Promise<HistoryActionResult> => ({ ok: true })),
    historyDistillDisable: vi.fn(async (): Promise<HistoryActionResult> => ({ ok: true })),
    historyDeleteNotes: vi.fn(async (): Promise<HistoryActionResult> => ({ ok: true })),
    historyPause: vi.fn(async () => undefined),
    historyResume: vi.fn(async () => undefined),
    ...over,
  };
  Object.assign(window, { electronAPI: api });
  return api;
}

const toggle = () => screen.getByRole('switch', { name: 'Decision notes (uses Claude Haiku)' });

describe('HistoryDistillSettings consent', () => {
  it('shows the estimate before anything can be enabled', async () => {
    const api = stubAPI();
    render(<HistoryDistillSettings distill={false} paused={false} />);
    expect(await screen.findByText(/42 groups of settled sessions/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.27/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.08/)).toBeInTheDocument();
    expect(screen.getByText(/per million input tokens/)).toBeInTheDocument();
    expect(screen.getByText(/subscription that\s+uses your plan limits rather than money/)).toBeInTheDocument();
    expect(screen.getByText(/2 more groups are from sessions active/)).toBeInTheDocument();
    expect(api.historyDistillEnable).not.toHaveBeenCalled();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it('calls enable only from the confirm step, never from the switch or Cancel', async () => {
    const api = stubAPI();
    const { rerender } = render(<HistoryDistillSettings distill={false} paused={false} />);
    await screen.findByText(/42 groups/);

    fireEvent.click(toggle());
    expect(api.historyDistillEnable).not.toHaveBeenCalled();
    expect(screen.getByText(/Run Claude Haiku on 42 groups/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Enable decision notes' })).toBeNull();
    expect(api.historyDistillEnable).not.toHaveBeenCalled();

    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Enable decision notes' }));
    expect(api.historyDistillEnable).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    // Main's app-settings broadcast lands the persisted consent; progress follows.
    rerender(<HistoryDistillSettings distill paused={false} status={STATUS} />);
    expect(await screen.findByText(/10 of 40 groups distilled · 37 notes/)).toBeInTheDocument();
    expect(screen.getByText(/Spent so far: \$0\.01/)).toBeInTheDocument();
  });

  it('shows an enable error and stays off', async () => {
    stubAPI({ historyDistillEnable: vi.fn(async () => ({ ok: false, error: 'Turn on workspace history first.' })) });
    render(<HistoryDistillSettings distill={false} paused={false} />);
    await screen.findByText(/42 groups/);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Enable decision notes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn on workspace history first.');
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });
});

describe('HistoryDistillSettings while on / after', () => {
  it('turns off immediately without deleting, and offers a confirmed delete only while off', async () => {
    const api = stubAPI();
    const { rerender } = render(<HistoryDistillSettings distill paused={false} status={STATUS} />);
    expect(screen.queryByRole('button', { name: 'Delete notes' })).toBeNull();
    fireEvent.click(toggle());
    expect(api.historyDistillDisable).toHaveBeenCalledTimes(1);
    expect(api.historyDeleteNotes).not.toHaveBeenCalled();

    rerender(<HistoryDistillSettings distill={false} paused={false} status={{ ...STATUS, enabled: false, state: 'off' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete notes' }));
    expect(api.historyDeleteNotes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 37 notes' }));
    expect(api.historyDeleteNotes).toHaveBeenCalledTimes(1);
  });

  it('shows a back-off error and pauses with workspace history', async () => {
    const api = stubAPI();
    render(<HistoryDistillSettings distill paused={false} status={{ ...STATUS, state: 'waiting', error: 'Claude AI usage limit reached' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('usage limit');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(api.historyPause).toHaveBeenCalledTimes(1);
  });

  it('is part of the history section only while history is on', async () => {
    const off: HistoryStatus = { enabled: false, progress: { state: 'off' }, workspaces: [] };
    stubAPI({
      historyGetStatus: vi.fn(async () => off),
      onHistoryStatus: vi.fn(() => () => {}),
    });
    const { rerender } = render(<HistorySettings enabled={false} integrations />);
    expect(screen.queryByRole('switch', { name: 'Decision notes (uses Claude Haiku)' })).toBeNull();
    rerender(<HistorySettings enabled integrations distill={false} />);
    expect(await screen.findByRole('switch', { name: 'Decision notes (uses Claude Haiku)' })).toBeInTheDocument();
  });

  it('survives a preload without the distill methods', () => {
    Object.assign(window, { electronAPI: {} });
    render(<HistoryDistillSettings distill={false} paused={false} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Enable decision notes' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/restart SplitGrid/);
  });
});

describe('formatting', () => {
  it('formats money so a real spend never reads as zero', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.00042)).toBe('$0.0004');
    expect(formatUsd(0.2715)).toBe('$0.27');
    expect(formatUsd(1234.4)).toBe('$1,234');
  });
  it('formats token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
    expect(formatTokens(25_000_000)).toBe('25M');
  });
});
