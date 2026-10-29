import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SOUND_ID, DEFAULT_VOLUME } from '../sounds';
import { DEFAULT_BACKGROUND_COLOR } from '../../shared/background-theme';

const FALLBACK: AppSettings = {
  defaultSoundId: DEFAULT_SOUND_ID,
  defaultVolume: DEFAULT_VOLUME,
  muteAll: false,
  terminalRenderer: 'xterm',
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
};

/**
 * Global notification defaults (default sound, default volume, mute-all),
 * persisted in the main process. Updates are optimistic + written through.
 */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(FALLBACK);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loaded = await window.electronAPI.getAppSettings();
        if (alive && loaded) setSettings(loaded);
      } catch (e) {
        console.error('Failed to load app settings:', e);
      }
    })();
    // Settings are global across environment windows: adopt any window's save.
    const unsubscribe = window.electronAPI.onAppSettingsChanged((next) => {
      if (alive) setSettings(next);
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

  // Only the patch is sent — main merges it onto the stored settings, so a stale
  // copy here can never overwrite what another window saved.
  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    window.electronAPI.saveAppSettings(patch).catch((e) => console.error('Failed to save app settings:', e));
  }, []);

  return { settings, update };
}
