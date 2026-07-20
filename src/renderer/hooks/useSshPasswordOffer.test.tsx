import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSshPasswordOffer } from './useSshPasswordOffer';

type Offer = { sessionId: string; label: string; source: 'sudo' | 'login' };

let fire: ((o: Offer) => void) | null = null;
const applySpy = vi.fn();

beforeEach(() => {
  fire = null;
  applySpy.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onSshPasswordPrompt: (cb: (o: Offer) => void) => { fire = cb; return () => { fire = null; }; },
    applySshPassword: applySpy,
  };
});

afterEach(() => cleanup());

describe('useSshPasswordOffer', () => {
  it('exposes an offer only for a matching sessionId', () => {
    const { result } = renderHook(() => useSshPasswordOffer('s1'));
    expect(result.current.offer).toBeNull();

    act(() => fire!({ sessionId: 'other', label: 'x', source: 'sudo' }));
    expect(result.current.offer).toBeNull(); // not for me

    act(() => fire!({ sessionId: 's1', label: 'prod-box', source: 'sudo' }));
    expect(result.current.offer).toEqual({ label: 'prod-box', source: 'sudo' });
    expect(result.current.activeRef.current).toBe(true);
  });

  it('apply() injects the password for the session and clears the offer', () => {
    const { result } = renderHook(() => useSshPasswordOffer('abc'));
    act(() => fire!({ sessionId: 'abc', label: 'l', source: 'login' }));
    act(() => result.current.apply());
    expect(applySpy).toHaveBeenCalledWith('abc');
    expect(result.current.offer).toBeNull();
    expect(result.current.activeRef.current).toBe(false);
  });

  it('dismiss() clears the offer without sending', () => {
    const { result } = renderHook(() => useSshPasswordOffer('s1'));
    act(() => fire!({ sessionId: 's1', label: 'l', source: 'sudo' }));
    act(() => result.current.dismiss());
    expect(applySpy).not.toHaveBeenCalled();
    expect(result.current.offer).toBeNull();
  });
});
