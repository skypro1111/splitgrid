import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { EnvironmentSummary } from '../../shared/types';

interface EnvironmentPickerProps {
  embedded?: boolean;
  onRequestClose?: () => void;
}

export const EnvironmentPicker: React.FC<EnvironmentPickerProps> = ({
  embedded = false,
  onRequestClose,
}) => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const [items, setItems] = useState<EnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingEnvId, setOpeningEnvId] = useState<string | null>(null);
  const [deletingEnvId, setDeletingEnvId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingEnvId, setEditingEnvId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const envs = await window.electronAPI.listEnvironments();
      setItems(envs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return window.electronAPI.onEnvironmentStateChange(() => {
      void load();
    });
  }, [load]);

  const openEnvironment = useCallback(async (envId?: string) => {
    if (openingEnvId) return;
    setOpeningEnvId(envId ?? '__new__');
    try {
      await window.electronAPI.openWorkspaceSetWindow(envId);
      if (embedded) {
        onRequestClose?.();
      } else {
        window.close();
      }
    } finally {
      setOpeningEnvId(null);
    }
  }, [openingEnvId, embedded, onRequestClose]);

  const openByFile = useCallback(async () => {
    const envId = await window.electronAPI.pickEnvironmentFile();
    if (!envId) return;
    await openEnvironment(envId);
  }, [openEnvironment]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((env) => {
      const haystack = `${env.name} ${env.id} ${env.path ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [items, search]);

  const startRename = useCallback((env: EnvironmentSummary) => {
    setEditingEnvId(env.id);
    setDraftName(env.name);
  }, []);

  const finishRename = useCallback(
    async (environmentId: string) => {
      await window.electronAPI.setEnvironmentName(environmentId, draftName.trim());
      setEditingEnvId(null);
      setDraftName('');
      await load();
    },
    [draftName, load]
  );

  const deleteEnvironment = useCallback(
    async (env: EnvironmentSummary) => {
      if (env.id === 'default' || env.isOpen || openingEnvId || deletingEnvId) return;
      const label = env.name || env.id;
      const ok = window.confirm(`Delete environment "${label}"?`);
      if (!ok) return;
      setDeletingEnvId(env.id);
      try {
        await window.electronAPI.deleteEnvironment(env.id);
        await load();
      } catch (error) {
        alert((error as Error).message || 'Failed to delete environment');
      } finally {
        setDeletingEnvId(null);
      }
    },
    [deletingEnvId, load, openingEnvId]
  );

  return (
    <div
      style={{
        minHeight: embedded ? '100%' : '100vh',
        height: embedded ? '100%' : undefined,
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          minHeight: 46,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 14px',
          paddingLeft: isMac ? 86 : 14,
          background: 'var(--bg-titlebar)',
          ...({ WebkitAppRegion: 'drag' } as any),
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          Open Environment
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, ...({ WebkitAppRegion: 'no-drag' } as any) }}>
          {embedded && (
            <button
              onClick={onRequestClose}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 12,
              }}
            >
              Close
            </button>
          )}
          <button
            onClick={() => openEnvironment()}
            disabled={!!openingEnvId || !!deletingEnvId}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--bg-surface)',
              color: openingEnvId || deletingEnvId ? 'var(--text-muted)' : 'var(--text-primary)',
              fontSize: 12,
            }}
          >
            New Window
          </button>
          <button
            onClick={openByFile}
            disabled={!!openingEnvId || !!deletingEnvId}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--bg-surface)',
              color: openingEnvId || deletingEnvId ? 'var(--text-muted)' : 'var(--text-primary)',
              fontSize: 12,
            }}
          >
            Browse File...
          </button>
          <button
            onClick={() => void load()}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 12,
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div
        style={{
          padding: '10px 14px 0',
          ...({ WebkitAppRegion: 'no-drag' } as any),
        }}
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search environments..."
          spellCheck={false}
          style={{
            width: '100%',
            height: 30,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: 12,
            padding: '0 10px',
          }}
        />
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading...</div>
        ) : filteredItems.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No environments found yet.</div>
        ) : (
          filteredItems.map((env) => (
            <div
              key={env.id}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg-surface)',
                padding: '10px 12px',
                color: 'var(--text-primary)',
                ...({ WebkitAppRegion: 'no-drag' } as any),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {editingEnvId === env.id ? (
                    <input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => { void finishRename(env.id); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void finishRename(env.id);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingEnvId(null);
                          setDraftName('');
                        }
                      }}
                      autoFocus
                      style={{
                        width: '100%',
                        height: 24,
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        fontSize: 12,
                        padding: '0 8px',
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => { if (!env.isOpen && !openingEnvId && !deletingEnvId) void openEnvironment(env.id); }}
                      disabled={!!env.isOpen || !!openingEnvId || !!deletingEnvId}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        color: env.isOpen || openingEnvId || deletingEnvId ? 'var(--text-muted)' : 'var(--text-primary)',
                        cursor: env.isOpen || openingEnvId || deletingEnvId ? 'default' : 'pointer',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {env.name}
                      </div>
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {env.isOpen && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--accent-yellow)',
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                        flexShrink: 0,
                      }}
                    >
                      Open
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 10,
                      color: env.source === 'file' ? 'var(--accent-blue)' : 'var(--accent-green)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.4,
                      flexShrink: 0,
                    }}
                  >
                    {env.source}
                  </div>
                  <button
                    onClick={() => startRename(env)}
                    title="Rename environment"
                    disabled={!!openingEnvId || !!deletingEnvId}
                    style={{
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color: openingEnvId || deletingEnvId ? 'var(--text-muted)' : 'var(--text-secondary)',
                      borderRadius: 6,
                      padding: '3px 8px',
                      fontSize: 11,
                    }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => { void deleteEnvironment(env); }}
                    title={
                      env.id === 'default'
                        ? 'Default environment cannot be deleted'
                        : env.isOpen
                          ? 'Close this environment window before deleting'
                          : 'Delete environment'
                    }
                    disabled={env.id === 'default' || !!env.isOpen || !!openingEnvId || !!deletingEnvId}
                    style={{
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color:
                        env.id === 'default' || env.isOpen || openingEnvId || deletingEnvId
                          ? 'var(--text-muted)'
                          : 'var(--accent-red)',
                      borderRadius: 6,
                      padding: '3px 8px',
                      fontSize: 11,
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {env.path ?? env.id}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
