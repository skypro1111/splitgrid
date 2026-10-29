// ─── Internal popup ⇄ service-worker messages ────────────────────────────────
// Not the wire protocol (that is src/shared/ext-protocol.ts) — this is only the
// extension talking to its own popup. Kept in its own module so both sides share
// one definition and neither guesses at field names.

import type { ExtTab } from '../../src/shared/ext-protocol';

export type ConnectionState = 'unpaired' | 'connecting' | 'connected' | 'disconnected';

export interface StatusReply {
  connection: ConnectionState;
  /** Name of the SplitGrid install we are paired with, once it says hello. */
  device: string | null;
  /** Last handshake/socket failure, for the popup to show verbatim. */
  lastError: string | null;
  tabs: ExtTab[];
}

export type PopupRequest =
  | { k: 'status' }
  | { k: 'pair'; code: string }
  | { k: 'unpair' }
  | { k: 'activate'; tabId: number }
  | { k: 'deactivate'; tabId: number }
  | { k: 'setWritable'; tabId: number; writable: boolean };

export interface ActionReply {
  ok: boolean;
  error?: string;
}

export type PopupResponse = StatusReply | ActionReply;
