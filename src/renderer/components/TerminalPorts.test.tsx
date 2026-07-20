import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalPortsButton } from './TerminalPorts';
import type { TerminalListenPort } from '../../shared/types';

const openExternal = vi.fn();
const killProcess = vi.fn();

beforeEach(() => {
  openExternal.mockReset();
  killProcess.mockReset().mockResolvedValue({ ok: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { openExternal, killProcess };
});

afterEach(() => cleanup());

const ports = (over?: TerminalListenPort[]): TerminalListenPort[] =>
  over ?? [{ port: 3000, pids: [200] }, { port: 8080, pids: [201, 202] }];

describe('TerminalPortsButton', () => {
  it('renders nothing when there are no ports', () => {
    const { container } = render(<TerminalPortsButton sessionId="s1" ports={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a count and opens a popover listing the ports', () => {
    render(<TerminalPortsButton sessionId="s1" ports={ports()} />);
    const btn = screen.getByTitle(/port/);
    expect(btn).toHaveTextContent('2'); // two ports
    fireEvent.click(btn);
    expect(screen.getByText(':3000')).toBeInTheDocument();
    expect(screen.getByText(':8080')).toBeInTheDocument();
  });

  it('opens the chosen port in the browser', () => {
    render(<TerminalPortsButton sessionId="s1" ports={ports()} />);
    fireEvent.click(screen.getByTitle(/port/));
    fireEvent.click(screen.getByText(':3000'));
    expect(openExternal).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('kills every PID holding a port', async () => {
    render(<TerminalPortsButton sessionId="s1" ports={ports()} />);
    fireEvent.click(screen.getByTitle(/port/));
    // :8080 is held by pids 201 and 202 — both get killed.
    const killButtons = screen.getAllByTitle(/Kill the process holding/);
    fireEvent.click(killButtons[1]);
    await waitFor(() => expect(killProcess).toHaveBeenCalledTimes(2));
    expect(killProcess).toHaveBeenCalledWith('s1', 201, 'KILL');
    expect(killProcess).toHaveBeenCalledWith('s1', 202, 'KILL');
  });

  it('surfaces a kill failure', async () => {
    killProcess.mockResolvedValue({ ok: false, error: 'Operation not permitted' });
    render(<TerminalPortsButton sessionId="s1" ports={[{ port: 3000, pids: [200] }]} />);
    fireEvent.click(screen.getByTitle(/port/));
    fireEvent.click(screen.getByTitle(/Kill the process holding/));
    expect(await screen.findByText('Operation not permitted')).toBeInTheDocument();
  });
});
