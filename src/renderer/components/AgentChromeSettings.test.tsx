import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentChromeSettings } from './AgentChromeSettings';
import type { AppSettings, ExtChannelStatus } from '../../shared/types';

afterEach(() => cleanup());

const CONTROL = /inspect a tab in your real browser/i;
const WRITE = /interact with pages/i;

const disconnected: ExtChannelStatus = { connected: false, clients: [], surfaces: [] };
const connected = (surfaces: ExtChannelStatus['surfaces'] = []): ExtChannelStatus => ({
  connected: true,
  clients: [{ clientId: 'c1', browser: 'Chrome 141', version: '1.0.0', connectedAt: 0 }],
  surfaces,
});

// The three ext* round-trips the block makes. Status is what it polls; the
// pairing pair is what the buttons call.
function stubAPI(status: ExtChannelStatus = disconnected) {
  const api = {
    extGetStatus: vi.fn(async () => status),
    extBeginPairing: vi.fn(async () => ({ code: '482913', expiresAt: Date.now() + 180_000 })),
    extCancelPairing: vi.fn(async () => undefined),
  };
  Object.assign(window, { electronAPI: api });
  return api;
}

// Stateful harness so flipping a toggle actually re-renders with the new value,
// the way SettingsModal's draft does.
const Harness: React.FC<{ initial?: Partial<AppSettings>; savedControl?: boolean }> = ({ initial, savedControl }) => {
  const [s, setS] = useState<Partial<AppSettings>>({ agentIntegrations: true, ...initial });
  return (
    <AgentChromeSettings
      integrations={!!s.agentIntegrations}
      control={!!s.agentChromeControl}
      write={!!s.agentChromeWrite}
      savedControl={savedControl ?? !!s.agentChromeControl}
      onChange={(patch) => setS((cur) => ({ ...cur, ...patch }))}
    />
  );
};

const controlSwitch = () => screen.getByRole('switch', { name: CONTROL });
const writeSwitch = () => screen.getByRole('switch', { name: WRITE });

describe('AgentChromeSettings gates', () => {
  beforeEach(() => { stubAPI(); });

  it('disables the write toggle while control is off, and enables it once control is on', () => {
    render(<Harness />);
    expect(writeSwitch()).toBeDisabled();

    fireEvent.click(controlSwitch());
    expect(controlSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(writeSwitch()).toBeEnabled();
  });

  it('keeps both toggles dead while the master agent opt-in is off', () => {
    render(<Harness initial={{ agentIntegrations: false }} />);
    expect(controlSwitch()).toBeDisabled();
    expect(writeSwitch()).toBeDisabled();
  });

  it('clears the write gate when control is switched back off', async () => {
    render(<Harness initial={{ agentChromeControl: true, agentChromeWrite: true }} />);
    // Let the first status poll land before touching anything.
    expect(await screen.findByText(/No extension paired/)).toBeInTheDocument();
    expect(writeSwitch()).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(controlSwitch());
    expect(writeSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(writeSwitch()).toBeDisabled();
  });
});

describe('AgentChromeSettings pairing block', () => {
  it('is hidden while control is off and appears when it is turned on', async () => {
    const api = stubAPI();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Pair browser extension/ })).toBeNull();
    expect(api.extGetStatus).not.toHaveBeenCalled();

    fireEvent.click(controlSwitch());
    expect(screen.getByRole('button', { name: /Pair browser extension/ })).toBeInTheDocument();
    await waitFor(() => expect(api.extGetStatus).toHaveBeenCalled());
  });

  it('shows the code from beginPairing, and cancelling gives the button back', async () => {
    const api = stubAPI();
    render(<Harness initial={{ agentChromeControl: true }} />);

    fireEvent.click(screen.getByRole('button', { name: /Pair browser extension/ }));
    expect(await screen.findByText('482913')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.extCancelPairing).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('482913')).toBeNull();
    expect(screen.getByRole('button', { name: /Pair browser extension/ })).toBeInTheDocument();
  });

  // "Nothing paired" and "paired with nothing activated" need different fixes,
  // so the block must not collapse them into one message.
  it('tells an unpaired channel apart from a paired one with no activated tab', async () => {
    stubAPI(disconnected);
    const { unmount } = render(<Harness initial={{ agentChromeControl: true }} />);
    expect(await screen.findByText(/No extension paired/)).toBeInTheDocument();
    unmount();

    stubAPI(connected());
    render(<Harness initial={{ agentChromeControl: true }} />);
    expect(await screen.findByText(/no tab is activated/)).toBeInTheDocument();
    expect(screen.getByText(/Chrome 141/)).toBeInTheDocument();
  });

  it('lists activated tabs, and marks one interactive only when both write gates are open', async () => {
    stubAPI(connected([
      { surface: 'tab:c1.842', title: 'Dashboard', url: 'http://localhost:3000/', writable: true, browser: 'Chrome 141' },
      { surface: 'tab:c1.900', title: 'Docs', url: 'https://example.com/docs', writable: false, browser: 'Chrome 141' },
    ]));
    render(<Harness initial={{ agentChromeControl: true }} />);

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('tab:c1.842')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/docs')).toBeInTheDocument();
    // agentChromeWrite is still off, so the extension's own switch isn't enough.
    expect(screen.getAllByText('read-only')).toHaveLength(2);

    fireEvent.click(writeSwitch());
    expect(await screen.findByText('interactive')).toBeInTheDocument();
    expect(screen.getAllByText('read-only')).toHaveLength(1);
  });

  // A renderer reloaded against an older preload has none of the ext* methods;
  // one TypeError out of a click handler takes the whole app down.
  it('survives a preload without the extension methods', async () => {
    Object.assign(window, { electronAPI: {} });
    render(<Harness initial={{ agentChromeControl: true }} />);

    fireEvent.click(screen.getByRole('button', { name: /Pair browser extension/ }));
    expect(await screen.findByText(/cannot pair/)).toBeInTheDocument();
    expect(screen.getByText(/No extension paired/)).toBeInTheDocument();
  });
});
