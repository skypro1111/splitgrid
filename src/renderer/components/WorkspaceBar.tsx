import React from 'react';

interface WorkspaceBarProps {
  isFullScreen?: boolean;
  workspaceName?: string;
}

const platform = window.electronAPI?.platform;
const IS_WINDOWS = platform === 'win32';
const IS_MAC = platform === 'darwin' || /mac|iphone|ipod|ipad/i.test(navigator.platform);
// Linux runs frameless (no native header), so the bar provides the window
// controls itself. macOS keeps its native inset traffic lights; Windows is native.
const IS_LINUX = platform === 'linux';

// Minimal traced glyphs for the Linux window controls (kept tiny + monochrome to
// match the bar). `close` gets a red hover, like a typical Linux titlebar.
const LinuxWindowControls: React.FC = () => {
  const btn: React.CSSProperties = {
    width: 28,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    borderRadius: 4,
    fontSize: 13,
    lineHeight: 1,
    padding: 0,
  };
  const hover = (bg: string, fg: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = bg; e.currentTarget.style.color = fg; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; },
  });
  return (
    <div style={{ display: 'flex', gap: 2, ...({ WebkitAppRegion: 'no-drag' } as any) }}>
      <button style={btn} {...hover('var(--bg-hover)', 'var(--text-primary)')} title="Minimize" onClick={() => window.electronAPI.windowMinimize()}>&#9472;</button>
      <button style={btn} {...hover('var(--bg-hover)', 'var(--text-primary)')} title="Maximize" onClick={() => window.electronAPI.windowToggleMaximize()}>&#9633;</button>
      <button style={btn} {...hover('var(--accent-red)', '#fff')} title="Close" onClick={() => window.electronAPI.windowClose()}>&#10005;</button>
    </div>
  );
};

export const WorkspaceBar: React.FC<WorkspaceBarProps> = ({
  isFullScreen = false,
  workspaceName,
}) => {
  // Windows uses the native title bar, so this custom strip is redundant — drop
  // it entirely. On macOS the strip exists for traffic-light room + window
  // dragging; in fullscreen both are gone, so hide it there too.
  if (IS_WINDOWS) return null;
  if (IS_MAC && isFullScreen) return null;

  return (
    <div
      style={{
        height: '36px',
        minHeight: '36px',
        background: 'var(--bg-titlebar)',
        borderBottom: '1px solid var(--border)',
        ...({ WebkitAppRegion: 'drag' } as any),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'relative',
        padding: '0 10px',
      }}
    >
      <div style={{ flex: 1 }} />

      <div
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: '55%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          pointerEvents: 'none',
        }}
        title={workspaceName ?? 'Workspace'}
      >
        {workspaceName ?? 'Workspace'}
      </div>

      {IS_LINUX ? <LinuxWindowControls /> : <div style={{ width: 1 }} />}
    </div>
  );
};
