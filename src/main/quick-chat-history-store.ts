import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastChatConversation, FastChatMessage } from '../shared/types';

const HISTORY_FILE = 'quick-chat-history.json';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const TITLE_MAX = 80;

function deriveTitle(messages: FastChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const raw = (firstUser?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Untitled chat';
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX)}…` : raw;
}

function sanitizeMessages(v: unknown): FastChatMessage[] {
  if (!Array.isArray(v)) return [];
  const out: FastChatMessage[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    if ((o.role === 'user' || o.role === 'assistant' || o.role === 'system') && typeof o.content === 'string') {
      out.push({ role: o.role, content: o.content });
    }
  }
  return out;
}

function sanitizeConversation(v: unknown): FastChatConversation | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const messages = sanitizeMessages(o.messages);
  if (messages.length === 0) return null;
  const now = Date.now();
  return {
    id: o.id,
    title: typeof o.title === 'string' && o.title ? o.title : deriveTitle(messages),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now,
    messages,
  };
}

/** Stores recent Fast chat conversations in userData, newest first, capped at a
 * caller-supplied limit (the user's quickChatHistoryLimit setting). */
export class QuickChatHistoryStore {
  private filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), HISTORY_FILE);
  }

  list(): FastChatConversation[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map(sanitizeConversation).filter((c): c is FastChatConversation => c !== null);
    } catch {
      return [];
    }
  }

  private write(conversations: FastChatConversation[]): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(conversations, null, 2), 'utf-8');
  }

  private normalizeLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit)));
  }

  /** Upsert a conversation by id (moved to the front) and trim to `limit`. A
   * limit of 0 disables history: existing entries are cleared and nothing saved. */
  save(input: { id: string; messages: FastChatMessage[] }, limit: number | undefined): void {
    const cap = this.normalizeLimit(limit);
    if (cap === 0) {
      if (existsSync(this.filePath)) this.write([]);
      return;
    }
    const messages = sanitizeMessages(input.messages);
    if (!input.id || messages.length === 0) return;

    const now = Date.now();
    const existing = this.list();
    const prior = existing.find((c) => c.id === input.id);
    const updated: FastChatConversation = {
      id: input.id,
      title: deriveTitle(messages),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      messages,
    };
    const next = [updated, ...existing.filter((c) => c.id !== input.id)].slice(0, cap);
    this.write(next);
  }

  delete(id: string): void {
    const next = this.list().filter((c) => c.id !== id);
    this.write(next);
  }

  clear(): void {
    this.write([]);
  }
}
