import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkspaceGrid } from './WorkspaceGrid';
import type { Container, LayoutNode } from '../../shared/types';

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    onFocusModeToggle: () => () => {},
    onContainerZoom: () => () => {},
    getWindowZoom: () => 0,
    setWindowZoom: () => {},
  };
});

afterEach(() => cleanup());

const container: Container = { id: 'c1', content: { type: 'empty' } };
const tree: LayoutNode = { type: 'leaf', containerId: 'c1' };

const props = (over: { tree: LayoutNode | null; containers?: Container[] }) => ({
  tree: over.tree,
  containers: over.containers ?? [container],
  zoomLevels: {},
  focusedContainerId: null,
  onTreeChange: vi.fn(),
  onZoomChange: vi.fn(),
  onFocusedContainerChange: vi.fn(),
  onSplit: vi.fn(),
  onClose: vi.fn(),
  onSwap: vi.fn(),
  onAddFirst: vi.fn(),
  renderContent: () => <div data-testid="pane" />,
});

describe('WorkspaceGrid empty state', () => {
  // Regression: the publishFocusMode effect used to sit *below* the `if (!tree)`
  // return, so an empty workspace rendered one hook fewer. Filling the first
  // container then blew up with "Rendered more hooks than during the previous
  // render". Every hook must run on both branches.
  it('keeps the hook count stable when the first container appears', () => {
    const { rerender, getByTestId, getByText } = render(<WorkspaceGrid {...props({ tree: null })} />);
    expect(getByText('Add Container')).toBeInTheDocument();

    expect(() => rerender(<WorkspaceGrid {...props({ tree })} />)).not.toThrow();
    expect(getByTestId('pane')).toBeInTheDocument();
  });

  // Regression: a leaf pointing at a container that is no longer there rendered
  // as an invisible cell filling the whole grid — the workspace looked empty but
  // never offered "Add Container", so no pane could be opened in it again.
  it('shows the empty state when the tree only holds dangling leaves', () => {
    const dangling: LayoutNode = {
      type: 'split', direction: 'horizontal', ratio: 0.5,
      first: { type: 'leaf', containerId: 'gone-1' },
      second: { type: 'leaf', containerId: 'gone-2' },
    };
    const { getByText } = render(<WorkspaceGrid {...props({ tree: dangling, containers: [] })} />);
    expect(getByText('Add Container')).toBeInTheDocument();
  });

  it('still renders the panes that survive next to a dangling leaf', () => {
    const mixed: LayoutNode = {
      type: 'split', direction: 'horizontal', ratio: 0.5,
      first: { type: 'leaf', containerId: 'gone' },
      second: { type: 'leaf', containerId: 'c1' },
    };
    const { getByTestId, queryByText } = render(<WorkspaceGrid {...props({ tree: mixed })} />);
    expect(getByTestId('pane')).toBeInTheDocument();
    expect(queryByText('Add Container')).not.toBeInTheDocument();
  });

  it('keeps the hook count stable when the last container goes away', () => {
    const { rerender, getByText } = render(<WorkspaceGrid {...props({ tree })} />);

    expect(() => rerender(<WorkspaceGrid {...props({ tree: null })} />)).not.toThrow();
    expect(getByText('Add Container')).toBeInTheDocument();
  });
});
