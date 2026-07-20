import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import type { FastChatConversation } from '../../shared/types';
import { useQuickChat } from '../hooks/useQuickChat';
import { MarkdownMessage } from './MarkdownMessage';
import { Select } from './Select';

// Input auto-grows up to 8 lines (line-height 24px) before it starts scrolling.
const INPUT_MAX_HEIGHT = 8 * 24;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
}

interface QuickChatPaletteProps {
  /** Whether the palette is visible. The component stays mounted when closed so
   * the conversation survives the resume grace window (resumeGraceMs). */
  open: boolean;
  onClose: () => void;
  /** Whether Settings → Fast chat has a usable backend configured. */
  configured: boolean;
  /** Models the user can pick from in the selector. May be empty. */
  models: string[];
  /** The pre-selected default model (from Settings → Fast chat). */
  defaultModel: string;
  /** How long (ms) a closed chat stays resumable before being discarded.
   * 0 discards immediately on close. */
  resumeGraceMs: number;
  /** Jump to the Fast chat settings tab. */
  onOpenSettings: () => void;
}

/** A command-palette-style overlay for quick, throwaway questions ("how do I
 * unpack a tar.gz on linux"). Opens centered, streams the answer as markdown
 * (output on top, input pinned at the bottom), and lets the user copy what they
 * need. Stays mounted while closed so a recent chat can be resumed for a while. */
export const QuickChatPalette: React.FC<QuickChatPaletteProps> = ({ open, onClose, configured, models, defaultModel, resumeGraceMs, onOpenSettings }) => {
  const chat = useQuickChat();
  const [input, setInput] = useState('');
  // Per-chat model selection. Defaults to the configured default and snaps back
  // to a valid option whenever the available list changes (e.g. after editing
  // Settings) so a removed model can never linger as the active selection.
  const [model, setModel] = useState(defaultModel);
  useEffect(() => {
    setModel((m) => (m && models.includes(m) ? m : defaultModel));
  }, [models, defaultModel]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-grow the input with its content, up to 8 lines (then it scrolls).
  // Runs on every value change, including programmatic ones (history recall).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [input]);

  // Questions the user has asked this session — recalled with ArrowUp.
  const userQuestions = useMemo(
    () => chat.messages.filter((m) => m.role === 'user').map((m) => m.content),
    [chat.messages],
  );
  const historyIdxRef = useRef<number>(-1);

  // Saved-conversation browser.
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<FastChatConversation[]>([]);
  const refreshHistory = useCallback(() => {
    window.electronAPI.quickChatHistoryList().then(setHistory).catch(() => setHistory([]));
  }, []);
  const openHistory = useCallback(() => { refreshHistory(); setShowHistory(true); }, [refreshHistory]);

  // Grace window: opening cancels any pending discard (and refocuses); closing
  // schedules the conversation to be cleared after RESUME_GRACE_MS, so reopening
  // within the window resumes the last chat. reset() is stable (useCallback []).
  const { reset } = chat;
  const discardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const clear = () => {
      if (discardTimerRef.current) { clearTimeout(discardTimerRef.current); discardTimerRef.current = null; }
    };
    if (open) {
      clear();
      inputRef.current?.focus();
      return;
    }
    discardTimerRef.current = setTimeout(() => {
      reset();
      setShowHistory(false);
      setInput('');
      discardTimerRef.current = null;
    }, Math.max(0, resumeGraceMs));
    return clear;
  }, [open, reset, resumeGraceMs]);

  // Keep the latest streamed tokens / answers in view (not while browsing
  // history). Depends on `open` too: reopening the palette remounts the chat
  // DOM at scrollTop 0, and a reopened conversation's messages are unchanged, so
  // without it the effect wouldn't re-run and the view would sit at the first
  // message. rAF so the (re)mounted conversation has laid out before we measure
  // scrollHeight — otherwise it lands at the top.
  useEffect(() => {
    if (!open || showHistory) return;
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [open, chat.messages, chat.streamingText, showHistory]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || chat.streaming) return;
    chat.send(text, model);
    setInput('');
    historyIdxRef.current = -1;
  }, [input, chat, model]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (chat.streaming) chat.cancel();
      else onClose();
      return;
    }
    // ArrowUp on an empty input walks back through prior questions.
    if (e.key === 'ArrowUp' && input === '' && userQuestions.length > 0 && historyIdxRef.current === -1) {
      e.preventDefault();
      historyIdxRef.current = userQuestions.length - 1;
      setInput(userQuestions[historyIdxRef.current]);
    }
  }, [submit, chat, onClose, input, userQuestions]);

  // Closed: stay mounted (hooks/state preserved for the grace window) but render
  // nothing.
  if (!open) return null;

  const hasConversation = chat.messages.length > 0 || chat.streaming || !!chat.error;
  // Expanded = the box fills the screen with output on top and the input pinned
  // to the bottom; collapsed = a single centred input (launcher). The flex-grow
  // transition animates the box growing from the centre, so the input glides
  // from the middle of the screen down to the bottom.
  const expanded = configured && (hasConversation || showHistory);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1100, padding: '6vh 20px',
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          // Fixed 60% of the app window for both the chat and the history (never
          // grows to full width — flex-grow used to do that on the wrong axis).
          width: '60%', minWidth: 'min(520px, 100%)', maxWidth: '100%', maxHeight: '88vh', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}
      >
        {/* Output region (on top) — history browser or the conversation. Kept
            mounted while configured so its height animates from 0 → open (the
            input glides from centre to bottom); the active view crossfades. */}
        {configured && (
          <div
            style={{
              maxHeight: expanded ? '78vh' : 0,
              minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
              transition: 'max-height 340ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {showHistory ? (
              <div key="history" className="fastchat-view" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 0' }}>
                {history.length === 0 ? (
                  <div style={{ padding: '16px 18px', fontSize: 13, color: 'var(--text-muted)' }}>
                    No saved chats yet.
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 18px 8px' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        Recent chats
                      </span>
                      <button
                        onClick={() => { window.electronAPI.quickChatHistoryClear().then(refreshHistory); }}
                        style={{ ...pillBtn, padding: '3px 9px', fontSize: 11 }}
                      >
                        Clear all
                      </button>
                    </div>
                    {history.map((conv) => (
                      <div
                        key={conv.id}
                        onClick={() => { chat.loadConversation(conv); setShowHistory(false); inputRef.current?.focus(); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {conv.title}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {relativeTime(conv.updatedAt)} · {conv.messages.filter((m) => m.role !== 'system').length} messages
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); window.electronAPI.quickChatHistoryDelete(conv.id).then(refreshHistory); }}
                          title="Delete"
                          style={{
                            width: 22, height: 22, flexShrink: 0, borderRadius: 6, border: 'none', cursor: 'pointer',
                            background: 'transparent', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1,
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div key="chat" ref={scrollRef} className="fastchat-view" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', padding: '14px 18px' }}>
                {chat.messages.map((m, i) => (
                  m.role === 'user' ? (
                    // User: right-aligned filled bubble.
                    <div key={i} className="fastchat-msg" style={{ display: 'flex', justifyContent: 'flex-end', margin: '14px 0' }}>
                      <div style={{
                        maxWidth: '82%', padding: '8px 12px', borderRadius: '12px 12px 4px 12px',
                        background: 'var(--bg-active)', color: 'var(--text-primary)',
                        fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                      }}>
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    // Assistant: left-aligned, full-width plain markdown.
                    <div key={i} className="fastchat-msg" style={{ display: 'flex', gap: 8, margin: '14px 0', minWidth: 0 }}>
                      <span style={assistantDot} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <MarkdownMessage content={m.content} />
                      </div>
                    </div>
                  )
                ))}
                {chat.streaming && (
                  <div className="fastchat-msg" style={{ display: 'flex', gap: 8, margin: '14px 0', minWidth: 0 }}>
                    <span style={assistantDot} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {chat.streamingText
                        ? <MarkdownMessage content={chat.streamingText} />
                        : <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Thinking…</span>}
                    </div>
                  </div>
                )}
                {chat.error && (
                  <div style={{ margin: '14px 0', fontSize: 13, color: 'var(--accent-red)', overflowWrap: 'anywhere' }}>
                    {chat.error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Not-configured hint (above the input). */}
        {!configured && (
          <div style={{ padding: '16px', fontSize: 13, color: 'var(--text-secondary)' }}>
            Set an OpenAI-compatible endpoint (base URL, API key, model) to start.
            <button onClick={onOpenSettings} style={{ ...pillBtn, marginLeft: 10 }}>Open settings</button>
          </div>
        )}

        {/* Input row — pinned to the bottom. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '14px 16px', borderTop: expanded ? '1px solid var(--border)' : 'none', flexShrink: 0 }}>
          <span style={{ fontSize: 16, lineHeight: '24px', color: 'var(--text-muted)', userSelect: 'none' }}>⚡</span>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); historyIdxRef.current = -1; }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={configured ? 'Ask anything…  (Enter to send, Shift+Enter for newline)' : 'Fast chat is not configured yet'}
            disabled={!configured}
            style={{
              flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
              color: 'var(--text-primary)', fontSize: 15, lineHeight: '24px', fontFamily: 'inherit',
              maxHeight: INPUT_MAX_HEIGHT, overflowY: 'auto',
            }}
          />
          {configured && models.length > 1 && (
            <div style={{ alignSelf: 'center', flexShrink: 0 }}>
              <Select
                value={model}
                onChange={setModel}
                title="Model"
                minWidth={120}
                options={models.map((m) => ({ value: m, label: m }))}
              />
            </div>
          )}
          {chat.streaming ? (
            <button onClick={chat.cancel} title="Stop" style={pillBtn}>Stop</button>
          ) : (
            <>
              {chat.messages.length > 0 && (
                <button onClick={chat.reset} title="New chat" style={pillBtn}>Clear</button>
              )}
              {configured && (
                <button
                  onClick={() => (showHistory ? setShowHistory(false) : openHistory())}
                  title="History"
                  style={{ ...pillBtn, ...(showHistory ? { borderColor: 'var(--accent)', color: 'var(--text-primary)' } : {}) }}
                >
                  History
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const pillBtn: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer',
  fontSize: 12, fontWeight: 600, background: 'transparent', color: 'var(--text-secondary)', flexShrink: 0,
};

// Small accent marker that flags an assistant turn (distinguishes it from the
// right-aligned user bubble).
const assistantDot: React.CSSProperties = {
  width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)',
  flexShrink: 0, marginTop: 8,
};
