import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SOUND_ID, DEFAULT_VOLUME } from '../sounds';

const FALLBACK: AppSettings = {
  defaultSoundId: DEFAULT_SOUND_ID,
  defaultVolume: DEFAULT_VOLUME,
  muteAll: false,
  terminalRenderer: 'xterm',
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
    return () => { alive = false; };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electronAPI.saveAppSettings(next).catch((e) => console.error('Failed to save app settings:', e));
      return next;
    });
  }, []);

  return { settings, update };
}
