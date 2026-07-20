// Wire protocol between the desktop producer, the relay, and web viewers.
//
// Output flows producer → relay → viewers. Input flows the other way —
// viewer → relay → producer → PTY — via the `input` message. Input is gated on
// the producer (desktop): it only writes to a PTY for a terminal the user is
// actively streaming, and the relay only forwards input for a live session in
// the same single-user room.

export interface SessionMeta {
  id: string;
  title: string;
  cols: number;
  rows: number;
  // Routing for the viewer's env → workspace → terminal grouping.
  envName?: string;
  workspaceName?: string;
}

// Desktop producer → relay.
export type ProducerMsg =
  | { t: 'hello'; sessions: SessionMeta[] } // full set on (re)connect
  | { t: 'open'; session: SessionMeta }
  | { t: 'data'; id: string; chunk: string } // PTY output, raw utf-8 (matches the app's onData)
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'close'; id: string };

// Relay → web viewer.
export type ViewerMsg =
  | { t: 'sessions'; sessions: SessionMeta[] }
  | { t: 'snapshot'; id: string; buffer: string } // scrollback replay for a late viewer
  | { t: 'open'; session: SessionMeta }
  | { t: 'data'; id: string; chunk: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'close'; id: string };

// Web viewer → relay. The only upstream message a viewer may send: keystrokes
// for a terminal it can see. The relay forwards it to the room's producers.
export type ViewerInMsg = { t: 'input'; id: string; data: string };

// Relay → desktop producer. Input forwarded from a viewer; the producer decides
// whether to apply it (only for a still-shared terminal).
export type ProducerInMsg = { t: 'input'; id: string; data: string };
