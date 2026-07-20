import { useCallback, useRef } from 'react';
import type { AppSettings, Workspace } from '../../shared/types';
import { playSound } from '../sounds';

const BURST_COALESCE_MS = 250;

interface Options {
  getSettings: () => AppSettings;
  getWorkspace: (workspaceId: string) => Workspace | undefined;
}

/**
 * Returns a stable callback to fire a "Done" notification sound, resolving the
 * effective sound + volume from per-workspace overrides falling back to the
 * global defaults. Honors per-workspace mute and the global mute-all, and
 * coalesces bursts (many terminals finishing at once → one sound).
 */
export function useNotificationSound(options: Options) {
  const optsRef = useRef(options);
  optsRef.current = options;
  const lastPlayedRef = useRef(0);

  return useCallback((_sessionId: string, workspaceId: string) => {
    const { getSettings, getWorkspace } = optsRef.current;
    const settings = getSettings();
    if (settings.muteAll) return;

    const ws = getWorkspace(workspaceId);
    if (ws?.notifyMuted) return;

    // null/undefined override → inherit default; 'none' → silent.
    const soundId = ws?.notifySoundId ?? settings.defaultSoundId;
    const volume = ws?.notifyVolume ?? settings.defaultVolume;

    const now = Date.now();
    if (now - lastPlayedRef.current < BURST_COALESCE_MS) return;
    lastPlayedRef.current = now;

    playSound(soundId, volume);
  }, []);
}
