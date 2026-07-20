import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useQuickChat } from './useQuickChat';

type ChunkCb = (p: { requestId: string; delta: string }) => void;
type DoneCb = (p: { requestId: string }) => void;
type ErrCb = (p: { requestId: string; error: string }) => void;

let chunkCb: ChunkCb | null = null;
let doneCb: DoneCb | null = null;
let errCb: ErrCb | null = null;
const askSpy = vi.fn();
const cancelSpy = vi.fn();
const historySaveSpy = vi.fn();

beforeEach(() => {
  chunkCb = doneCb = errCb = null;
  askSpy.mockReset().mockResolvedValue({ ok: true });
  cancelSpy.mockReset();
  historySaveSpy.mockReset().mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    fastChatAsk: askSpy,
    fastChatCancel: cancelSpy,
    quickChatHistorySave: historySaveSpy,
    onFastChatChunk: (cb: ChunkCb) => { chunkCb = cb; return () => { chunkCb = null; }; },
    onFastChatDone: (cb: DoneCb) => { doneCb = cb; return () => { doneCb = null; }; },
    onFastChatError: (cb: ErrCb) => { errCb = cb; return () => { errCb = null; }; },
  };
});

afterEach(() => cleanup());

// The requestId the hook generates is opaque; grab it from the ask() call.
const lastRequestId = () => askSpy.mock.calls[askSpy.mock.calls.length - 1][0] as string;

describe('useQuickChat', () => {
  it('streams chunks then commits an assistant turn on done', async () => {
    const { result } = renderHook(() => useQuickChat());

    await act(async () => { await result.current.send('how to unzip'); });
    expect(askSpy).toHaveBeenCalledTimes(1);
    // User turn is appended; wire history carries it.
    expect(result.current.messages).toEqual([{ role: 'user', content: 'how to unzip' }]);
    expect(askSpy.mock.calls[0][1]).toEqual([{ role: 'user', content: 'how to unzip' }]);
    expect(result.current.streaming).toBe(true);

    const id = lastRequestId();
    act(() => { chunkCb!({ requestId: id, delta: 'Use ' }); });
    act(() => { chunkCb!({ requestId: id, delta: '`unzip`' }); });
    expect(result.current.streamingText).toBe('Use `unzip`');

    act(() => { doneCb!({ requestId: id }); });
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.streamingText).toBe('');
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'how to unzip' },
      { role: 'assistant', content: 'Use `unzip`' },
    ]);
  });

  it('ignores chunks from a stale requestId', async () => {
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('q'); });
    act(() => { chunkCb!({ requestId: 'not-the-active-one', delta: 'garbage' }); });
    expect(result.current.streamingText).toBe('');
  });

  it('surfaces a streamed error event and stops streaming', async () => {
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('q'); });
    const id = lastRequestId();
    act(() => { errCb!({ requestId: id, error: 'HTTP 400 Bad Request' }); });
    await waitFor(() => expect(result.current.error).toBe('HTTP 400 Bad Request'));
    expect(result.current.streaming).toBe(false);
  });

  it('surfaces a not-configured error from ask()', async () => {
    askSpy.mockResolvedValue({ ok: false, error: 'Fast chat is not configured.' });
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('q'); });
    await waitFor(() => expect(result.current.error).toBe('Fast chat is not configured.'));
    expect(result.current.streaming).toBe(false);
  });

  it('does not start a second request while one is in flight', async () => {
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('first'); });
    await act(async () => { await result.current.send('second'); });
    expect(askSpy).toHaveBeenCalledTimes(1);
  });

  it('cancel keeps partial text as a committed assistant turn', async () => {
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('q'); });
    const id = lastRequestId();
    act(() => { chunkCb!({ requestId: id, delta: 'partial' }); });
    act(() => { result.current.cancel(); });
    expect(cancelSpy).toHaveBeenCalledWith(id);
    expect(result.current.streaming).toBe(false);
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'partial' },
    ]);
  });

  it('reset clears the conversation and cancels any in-flight request', async () => {
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('q'); });
    const id = lastRequestId();
    act(() => { result.current.reset(); });
    expect(cancelSpy).toHaveBeenCalledWith(id);
    expect(result.current.messages).toEqual([]);
    expect(result.current.streaming).toBe(false);
  });

  it('persists the conversation to history when a turn completes', async () => {
    const { result } = renderHook(() => useQuickChat());
    await act(async () => { await result.current.send('how to unzip'); });
    const id = lastRequestId();
    act(() => { chunkCb!({ requestId: id, delta: 'Use unzip' }); });
    act(() => { doneCb!({ requestId: id }); });
    await waitFor(() => expect(historySaveSpy).toHaveBeenCalledTimes(1));
    const arg = historySaveSpy.mock.calls[0][0];
    expect(typeof arg.id).toBe('string');
    expect(arg.messages).toEqual([
      { role: 'user', content: 'how to unzip' },
      { role: 'assistant', content: 'Use unzip' },
    ]);
  });

  it('loadConversation replaces the chat and continues under the same history id', async () => {
    const { result } = renderHook(() => useQuickChat());
    const conv = {
      id: 'conv-xyz', title: 't', createdAt: 1, updatedAt: 2,
      messages: [
        { role: 'user' as const, content: 'old q' },
        { role: 'assistant' as const, content: 'old a' },
      ],
    };
    act(() => { result.current.loadConversation(conv); });
    expect(result.current.messages).toEqual(conv.messages);

    // A new turn carries the loaded history forward and saves under the same id.
    await act(async () => { await result.current.send('follow up'); });
    expect(askSpy.mock.calls[0][1]).toEqual([
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old a' },
      { role: 'user', content: 'follow up' },
    ]);
    const id = lastRequestId();
    act(() => { chunkCb!({ requestId: id, delta: 'new a' }); });
    act(() => { doneCb!({ requestId: id }); });
    await waitFor(() => expect(historySaveSpy).toHaveBeenCalled());
    expect(historySaveSpy.mock.calls.at(-1)![0].id).toBe('conv-xyz');
  });
});
