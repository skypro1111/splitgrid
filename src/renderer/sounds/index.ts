// Notification sounds bundled with the app. Vite turns each mp3 import into a
// served asset URL, so the renderer can play them with `new Audio(url)`.
import bright1 from './notification-bright-1.mp3';
import error1 from './notification-error-1.mp3';
import jump1 from './notification-jump-1.mp3';
import new1 from './notification-new-1.mp3';
import new2 from './notification-new-2.mp3';
import new3 from './notification-new-3.mp3';
import new4 from './notification-new-4.mp3';
import power1 from './notification-power-1.mp3';
import space1 from './notification-space-1.mp3';

export interface SoundOption {
  id: string;
  label: string;
  url: string;
}

// Order = order shown in pickers.
export const SOUNDS: SoundOption[] = [
  { id: 'notification-new-1', label: 'New 1', url: new1 },
  { id: 'notification-new-2', label: 'New 2', url: new2 },
  { id: 'notification-new-3', label: 'New 3', url: new3 },
  { id: 'notification-new-4', label: 'New 4', url: new4 },
  { id: 'notification-bright-1', label: 'Bright', url: bright1 },
  { id: 'notification-jump-1', label: 'Jump', url: jump1 },
  { id: 'notification-power-1', label: 'Power', url: power1 },
  { id: 'notification-space-1', label: 'Space', url: space1 },
  { id: 'notification-error-1', label: 'Error', url: error1 },
];

// Sentinel id meaning "play nothing".
export const SILENT_SOUND_ID = 'none';

export const DEFAULT_SOUND_ID = 'notification-new-1';
export const DEFAULT_VOLUME = 0.5;

const URL_BY_ID = new Map(SOUNDS.map((s) => [s.id, s.url]));

/** Resolve a sound id to its asset URL, or null for silent / unknown ids. */
export function soundUrl(id: string | null | undefined): string | null {
  if (!id || id === SILENT_SOUND_ID) return null;
  return URL_BY_ID.get(id) ?? null;
}

/** Play a sound by id at the given volume (0..1). No-op for silent/unknown ids. */
export function playSound(id: string | null | undefined, volume = DEFAULT_VOLUME): void {
  const url = soundUrl(id);
  if (!url) return;
  try {
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.play().catch(() => {});
  } catch {
    // Best effort.
  }
}
