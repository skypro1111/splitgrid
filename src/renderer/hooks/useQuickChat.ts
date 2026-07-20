import { useCallback, useEffect, useRef, useState } from 'react';
import type { FastChatConversation, FastChatMessage } from '../../shared/types';

export interface QuickChatState {
  /** Committed turns (user + assistant), oldest first. */
  messages: FastChatMessage[];
  /** Assistant text currently streaming in (empty when idle). */
  streamingText: string;
  streaming: boolean;
  error: string | null;
}

/**
 * Drives a single Fast chat conversation against the configured OpenAI-compatible
 * endpoint (Settings → Fast chat). The API key stays in the main process; here we
 * only send messages and accumulate streamed token deltas. One request at a time.
 */
export function useQuickChat() {
  const [state, setState] = useState<QuickChatState>({
    messages: [],
    streamingText: '',
    streaming: false,
    error: null,
  });

  // The request whose chunks we currently accept. Stale events (from a cancelled
  // or superseded request) are ignored by comparing against this.
  const activeIdRef = useRef<string | null>(null);
  const accRef = useRef('');
  const seqRef = useRef(0);
  // Id of the conversation being persisted to history. Assigned on the first
  // send of a fresh chat, carried across turns, reset by reset()/loadConversation.
  const convIdRef = useRef<string | null>(null);
  // Mirror of the committed messages, kept in sync via the effect below. `send`
  // reads this synchronously to build the wire history — React does not run
  // setState updaters eagerly, so we must not derive the request body inside one.
  const messagesRef = useRef<FastChatMessage[]>([]);
  useEffect(() => { messagesRef.current = state.messages; }, [state.messages]);

  // Persist the current conversation to history (best-effort, fire-and-forget).
  const persist = useCallback((messages: FastChatMessage[]) => {
    const id = convIdRef.current;
    if (!id || messages.length === 0) return;
    window.electronAPI.quickChatHistorySave({ id, messages }).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    const offChunk = window.electronAPI.onFastChatChunk(({ requestId, delta }) => {
      if (requestId !== activeIdRef.current) return;
      accRef.current += delta;
      setState((s) => ({ ...s, streamingText: accRef.current }));
    });
    const offDone = window.electronAPI.onFastChatDone(({ requestId }) => {
      if (requestId !== activeIdRef.current) return;
      const text = accRef.current;
      activeIdRef.current = null;
      accRef.current = '';
      const next = text ? [...messagesRef.current, { role: 'assistant' as const, content: text }] : messagesRef.current;
      messagesRef.current = next;
      setState((s) => ({ ...s, messages: next, streamingText: '', streaming: false }));
      if (text) persist(next);
    });
    const offError = window.electronAPI.onFastChatError(({ requestId, error }) => {
      if (requestId !== activeIdRef.current) return;
      activeIdRef.current = null;
      accRef.current = '';
      setState((s) => ({ ...s, streamingText: '', streaming: false, error }));
    });
    return () => { offChunk(); offDone(); offError(); };
  }, []);

  const send = useCallback(async (prompt: string, model?: string) => {
    const text = prompt.trim();
    if (!text || activeIdRef.current) return;

    // Build the wire history from the synchronously-available ref, then
    // optimistically append the user's turn for display.
    const userMsg: FastChatMessage = { role: 'user', content: text };
    const history: FastChatMessage[] = [...messagesRef.current, userMsg];
    messagesRef.current = history;
    // A fresh chat gets a conversation id on its first turn; reused thereafter.
    if (!convIdRef.current) convIdRef.current = `conv-${Date.now()}-${seqRef.current++}`;
    setState((s) => ({
      ...s,
      messages: [...s.messages, userMsg],
      streamingText: '',
      streaming: true,
      error: null,
    }));

    accRef.current = '';
    // Generate the id here and arm the listener before the request starts, so a
    // token can never arrive before we know which request it belongs to.
    const requestId = `qc-${Date.now()}-${seqRef.current++}`;
    activeIdRef.current = requestId;
    try {
      const res = await window.electronAPI.fastChatAsk(requestId, history, model);
      if (!res.ok) {
        if (activeIdRef.current === requestId) activeIdRef.current = null;
        setState((s) => ({ ...s, streaming: false, error: res.error ?? 'Fast chat request failed.' }));
      }
    } catch (e) {
      if (activeIdRef.current === requestId) activeIdRef.current = null;
      setState((s) => ({ ...s, streaming: false, error: (e as Error).message }));
    }
  }, []);

  const cancel = useCallback(() => {
    const id = activeIdRef.current;
    if (id) window.electronAPI.fastChatCancel(id);
    activeIdRef.current = null;
    // Keep whatever streamed so far as a committed assistant turn.
    const text = accRef.current;
    accRef.current = '';
    const next = text ? [...messagesRef.current, { role: 'assistant' as const, content: text }] : messagesRef.current;
    messagesRef.current = next;
    setState((s) => ({ ...s, messages: next, streamingText: '', streaming: false }));
    if (text) persist(next);
  }, [persist]);

  const reset = useCallback(() => {
    const id = activeIdRef.current;
    if (id) window.electronAPI.fastChatCancel(id);
    activeIdRef.current = null;
    accRef.current = '';
    convIdRef.current = null;
    messagesRef.current = [];
    setState({ messages: [], streamingText: '', streaming: false, error: null });
  }, []);

  // Open a saved conversation: replace the current chat and continue it under the
  // same history id (further turns update the same entry).
  const loadConversation = useCallback((conv: FastChatConversation) => {
    const id = activeIdRef.current;
    if (id) window.electronAPI.fastChatCancel(id);
    activeIdRef.current = null;
    accRef.current = '';
    convIdRef.current = conv.id;
    messagesRef.current = conv.messages;
    setState({ messages: conv.messages, streamingText: '', streaming: false, error: null });
  }, []);

  return { ...state, send, cancel, reset, loadConversation };
}
