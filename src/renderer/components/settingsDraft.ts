import type { AppSettings } from '../../shared/types';

// Settings modal draft vs. settings saved by OTHER environment windows. The
// draft starts as a copy of `base` (the settings it was taken from); only keys
// the user actually edited may be written back, and keys they did not touch
// follow whatever another window saves while the modal is open.

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const keysOf = (...objs: AppSettings[]) =>
  Array.from(new Set(objs.flatMap((o) => Object.keys(o)))) as (keyof AppSettings)[];

/** The keys of `draft` that differ from `base` — what the user edited. */
export function settingsPatch(base: AppSettings, draft: AppSettings): Partial<AppSettings> {
  const patch: Record<string, unknown> = {};
  for (const k of keysOf(base, draft)) {
    if (!same(base[k], draft[k])) patch[k] = draft[k];
  }
  return patch as Partial<AppSettings>;
}

/** Move `draft` from `base` onto `next`, keeping only the user's own edits. */
export function rebaseSettingsDraft(draft: AppSettings, base: AppSettings, next: AppSettings): AppSettings {
  return { ...next, ...settingsPatch(base, draft) };
}
