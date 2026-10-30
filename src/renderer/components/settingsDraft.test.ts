import { describe, it, expect } from 'vitest';
import { rebaseSettingsDraft, settingsPatch } from './settingsDraft';
import type { AppSettings } from '../../shared/types';

const base: AppSettings = {
  defaultSoundId: 's1', defaultVolume: 0.5, muteAll: false, terminalRenderer: 'xterm', backgroundColor: '#000000',
};

describe('settingsPatch', () => {
  it('carries only the edited keys, compared structurally', () => {
    const draft: AppSettings = { ...base, muteAll: true, fastChat: { baseUrl: 'u', apiKey: 'k', model: 'm', temperature: 0.2 } };
    expect(settingsPatch(base, { ...base })).toEqual({});
    expect(settingsPatch(base, draft)).toEqual({ muteAll: true, fastChat: { baseUrl: 'u', apiKey: 'k', model: 'm', temperature: 0.2 } });
  });
});

describe('rebaseSettingsDraft', () => {
  it('adopts another window’s save for untouched keys and keeps the user’s edits', () => {
    const draft: AppSettings = { ...base, defaultVolume: 0.9 };
    const next: AppSettings = { ...base, muteAll: true, backgroundColor: '#111111' };
    expect(rebaseSettingsDraft(draft, base, next)).toEqual({ ...next, defaultVolume: 0.9 });
  });
});

// historyEnabled is written by main (history:enable / history:disable) while the
// modal is open; the draft must follow it and never write a stale value back.
describe('historyEnabled flipped by main while the modal is open', () => {
  it('is adopted by the draft and left out of the Save patch', () => {
    const draft: AppSettings = { ...base, historyEnabled: false, muteAll: true };
    const next: AppSettings = { ...base, historyEnabled: true };
    const rebased = rebaseSettingsDraft(draft, { ...base, historyEnabled: false }, next);
    expect(rebased.historyEnabled).toBe(true);
    expect(settingsPatch(next, rebased)).toEqual({ muteAll: true });
  });
});
