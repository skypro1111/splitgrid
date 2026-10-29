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
