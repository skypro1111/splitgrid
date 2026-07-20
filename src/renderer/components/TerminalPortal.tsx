import React, { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { GridTerminal } from './GridTerminal';
import { XtermTerminal } from './XtermTerminal';
import type {
  TerminalRendererKind,
  TerminalRendererMetrics,
  TerminalSessionInfo,
  Container,
} from '../../shared/types';

interface TerminalPortalProps {
  container: Container;
  workspaceId: string;
  visible: boolean;
  session?: TerminalSessionInfo;
  zoomLevel: number;
  sendData: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  getBuffer: (id: string) => Promise<string>;
  registerWriter: (id: string, fn: (data: string) => void) => void;
  unregisterWriter: (id: string) => void;
  reportRendererMetrics: (metrics: TerminalRendererMetrics) => void;
  removeRendererMetrics: (sessionId: string) => void;
  onClose: () => void;
  onReconnect?: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onOpenAgentBrowser?: (sessionId: string) => void;
  // Rename this terminal (sets a custom name; null resets to the auto name).
  onRename?: (name: string | null) => void;
  // Whether this terminal is currently streaming to the web relay.
  streaming?: boolean;
  // Whether a WorkOS account is signed in — web streaming requires it, so the
  // toggle is disabled (with a prompt to sign in) when false.
  canStream?: boolean;
  // Toggle web streaming for this terminal; receives the new state + live size.
  onToggleStreaming?: (enabled: boolean, live: { cols: number; rows: number }) => void;
  // Global rendering engine for all terminals (from app Settings → Terminal).
  terminalRenderer: TerminalRendererKind;
  workspaceSwitchToken?: string;
}

/**
 * Stable wrapper kept across workspace switches and layout changes.
 * Mirrors IDEPortal so the terminal never unmounts when the active workspace
 * changes — its DOM is reparented into whichever data-terminal-target
 * placeholder is currently in the layout, instead of being torn down.
 */
export const TerminalPortal: React.FC<TerminalPortalProps> = ({
  container,
  workspaceId,
  visible,
  session,
  zoomLevel,
  sendData,
  resize,
  getBuffer,
  registerWriter,
  unregisterWriter,
  reportRendererMetrics,
  removeRendererMetrics,
  onClose,
  onReconnect,
  onSplitRight,
  onSplitDown,
  onOpenAgentBrowser,
  onRename,
  streaming,
  canStream,
  onToggleStreaming,
  terminalRenderer,
  workspaceSwitchToken,
}) => {
  const containerId = container.id;
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  if (!wrapperRef.current) {
    const el = document.createElement('div');
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.overflow = 'hidden';
    wrapperRef.current = el;
  }

  const attachToTarget = useCallback(() => {
    const target = document.querySelector<HTMLElement>(
      `[data-terminal-target="${containerId}"]`,
    );
    const wrapper = wrapperRef.current;
    if (!target || !wrapper) return;
    if (wrapper.parentElement !== target) {
      target.appendChild(wrapper);
    }
    window.dispatchEvent(new CustomEvent('splitgrid:terminal-portal-attached', {
      detail: { containerId },
    }));
  }, [containerId]);

  useLayoutEffect(attachToTarget, [attachToTarget]);

  useEffect(() => {
    const handleTargetMounted = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; containerId?: string }>).detail;
      if (detail?.kind === 'terminal' && detail.containerId === containerId) {
        attachToTarget();
      }
    };

    window.addEventListener('splitgrid:portal-target-mounted', handleTargetMounted);
    return () => {
      window.removeEventListener('splitgrid:portal-target-mounted', handleTargetMounted);
      wrapperRef.current?.remove();
    };
  }, [attachToTarget, containerId]);

  if (container.content.type !== 'terminal' || !session) {
    return createPortal(null, wrapperRef.current);
  }

  const commonTerminalProps = {
    containerId,
    session,
    sendData,
    resize,
    getBuffer,
    registerWriter,
    unregisterWriter,
    reportRendererMetrics,
    removeRendererMetrics,
    onClose,
    onReconnect,
    onSplitRight,
    onSplitDown,
    onOpenAgentBrowser,
    zoomLevel,
    workspaceId,
    visible,
    historyOutput: container.content.terminalOutput,
    workspaceSwitchToken,
    customName: container.content.customName,
    onRename,
    streaming,
    canStream,
    onToggleStreaming,
  };

  return createPortal(
    terminalRenderer === 'ghostty'
      ? <GridTerminal key="ghostty" {...commonTerminalProps} />
      : <XtermTerminal key="xterm" {...commonTerminalProps} />,
    wrapperRef.current,
  );
};
