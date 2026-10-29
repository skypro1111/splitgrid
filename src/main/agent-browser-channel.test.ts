import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocketClient from 'ws';

// The extension channel is the ONLY thing standing between "any page in the
// user's browser can open a loopback WebSocket" and "an agent drives the user's
// logged-in browser". These tests pin the gate: the Origin check, the pairing
// code (single use, expiring, rate-limited), the token check, and the settings
// write gate — plus the correlation/timeout bookkeeping that must never leak a
// hanging promise.
//
// Electron is mocked so the module loads under node; userData points at a temp
// dir, so the pairing file and the app-settings file are the REAL ones on disk
// (which is what makes the "pair, reconnect with the token" test meaningful).

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import {
  __extChannelInternals, beginPairing, cancelPairing, isAllowedExtensionOrigin,
  isExtensionConnected, listExtensionClients, listExtensionSurfaces,
  runExtensionCommand, startExtensionChannel, stopExtensionChannel,
  EXT_AMBIGUOUS_TAB, EXT_DISABLED, type ChannelSocket, type ExtClientState,
} from './agent-browser-channel';
import {
  EXT_ERRORS, EXT_PROTOCOL_VERSION, EXT_WS_PATH, type DesktopToExt,
} from '../shared/ext-protocol';

paths.userData = mkdtempSync(path.join(os.tmpdir(), 'sg-ext-channel-'));

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

function identityFor(extensionId: string) {
  return { extensionId, browser: 'Chrome 141', version: '1.0.0' };
}

// Persist the two gates the way Settings would, so runExtensionCommand reads
// them through the real AppSettingsStore rather than a stand-in.
function setGates(control: boolean, write: boolean): void {
  writeFileSync(
    path.join(paths.userData, 'app-settings.json'),
    JSON.stringify({ agentChromeControl: control, agentChromeWrite: write }),
    'utf-8',
  );
}

interface FakeSocket {
  sent: DesktopToExt[];
  closed: { code?: number; reason?: string } | null;
  socket: ChannelSocket;
  last<T extends DesktopToExt['t']>(t: T): Extract<DesktopToExt, { t: T }> | undefined;
}

function fakeSocket(): FakeSocket {
  const f: FakeSocket = {
    sent: [],
    closed: null,
    socket: {
      send: (data: string) => { f.sent.push(JSON.parse(data) as DesktopToExt); },
      close: (code?: number, reason?: string) => { f.closed ??= { code, reason }; },
    },
    last: (t) => [...f.sent].reverse().find((m) => m.t === t) as never,
  };
  return f;
}

function connectFake(extensionId = EXT_ID): { f: FakeSocket; client: ExtClientState } {
  const f = fakeSocket();
  return { f, client: __extChannelInternals.attachSocket(f.socket, extensionId) };
}

function feed(client: ExtClientState, msg: Record<string, unknown>): void {
  __extChannelInternals.handleClientMessage(client, JSON.stringify(msg));
}

/** Connect + complete a real pairing round, returning the minted token. */
function pairFake(extensionId = EXT_ID): { f: FakeSocket; client: ExtClientState; token: string } {
  const { code } = beginPairing();
  const { f, client } = connectFake(extensionId);
  feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identityFor(extensionId) });
  const ok = f.last('pair-ok');
  if (!ok) throw new Error('pairing failed in test setup');
  return { f, client, token: ok.token };
}

/** Connect + authenticate with an already-minted token, i.e. a reconnect. */
function helloFake(token: string, extensionId = EXT_ID): { f: FakeSocket; client: ExtClientState } {
  const { f, client } = connectFake(extensionId);
  feed(client, { t: 'hello', protocol: EXT_PROTOCOL_VERSION, token, identity: identityFor(extensionId) });
  return { f, client };
}

const PAIRINGS_FILE = 'browser-extension-pairings.json';

function readPairings(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path.join(paths.userData, PAIRINGS_FILE), 'utf-8')) as Array<Record<string, unknown>>;
}

/** Seed the pairing file the way an older build (or the user's live install)
 *  would have left it. Only meaningful together with restartApp(). */
function writePairings(records: Array<Record<string, unknown>>): void {
  writeFileSync(path.join(paths.userData, PAIRINGS_FILE), JSON.stringify(records, null, 2), 'utf-8');
}

/** Drop everything the channel holds in memory: as if the app had restarted, so
 *  the pairing file on disk is the only thing that survives. */
function restartApp(): void {
  __extChannelInternals.reset();
  __extChannelInternals.setTiming({ heartbeatMs: 60_000, authTimeoutMs: 60_000 });
}

function pushTab(client: ExtClientState, tabId: number): void {
  feed(client, {
    t: 'tabs',
    tabs: [{ tabId, title: 'Local', url: 'http://localhost:3000/', origin: 'http://localhost:3000', writable: true, activatedAt: Date.now() }],
  });
}

describe('agent browser channel', () => {
  beforeEach(() => {
    setGates(true, true);
    __extChannelInternals.setTiming({ heartbeatMs: 60_000, authTimeoutMs: 60_000 });
  });
  afterEach(() => {
    __extChannelInternals.reset();
  });

  // ─── Origin gate ───────────────────────────────────────────────────────────

  describe('origin gate', () => {
    it('accepts only extension origins', () => {
      expect(isAllowedExtensionOrigin(`chrome-extension://${EXT_ID}`)).toBe(true);
      expect(isAllowedExtensionOrigin('moz-extension://f81d4fae-7dec-11d0-a765-00a0c91e6bf6')).toBe(true);
      for (const bad of [
        undefined, '', 'null', 'http://localhost:3000', 'https://evil.example',
        'file://', 'https://chrome-extension://x', 'chrome-extension://', 'ws://127.0.0.1:19558',
      ]) {
        expect(isAllowedExtensionOrigin(bad), String(bad)).toBe(false);
      }
    });

    it('refuses the WebSocket upgrade from a web page origin and accepts an extension one', async () => {
      const server = createServer();
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      startExtensionChannel(server);
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${EXT_WS_PATH}`;

      const open = (origin: string | undefined): Promise<WebSocketClient> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocketClient(url, origin ? { headers: { Origin: origin } } : {});
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        });

      // Any page in the browser can reach loopback and CORS does not apply, so
      // this rejection is the whole reason the channel is safe to expose.
      await expect(open('https://evil.example')).rejects.toThrow(/403/);
      await expect(open(undefined)).rejects.toThrow(/403/);

      const good = await open(`chrome-extension://${EXT_ID}`);
      expect(good.readyState).toBe(WebSocketClient.OPEN);
      good.close();

      stopExtensionChannel();
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('leaves upgrades on other paths for other features to handle', async () => {
      const server = createServer();
      const seen: string[] = [];
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      startExtensionChannel(server);
      // Registered AFTER ours: it must still see the non-/ext upgrade, i.e. our
      // listener neither answered nor destroyed the socket.
      server.on('upgrade', (req, socket) => { seen.push(req.url ?? ''); socket.destroy(); });
      const port = (server.address() as AddressInfo).port;

      await new Promise<void>((resolve) => {
        const ws = new WebSocketClient(`ws://127.0.0.1:${port}/something-else`, { headers: { Origin: 'https://evil.example' } });
        ws.on('error', () => resolve());
        ws.on('open', () => { ws.close(); resolve(); });
      });
      expect(seen).toEqual(['/something-else']);

      stopExtensionChannel();
      await new Promise<void>((r) => server.close(() => r()));
    });
  });

  // ─── Pairing ───────────────────────────────────────────────────────────────

  describe('pairing', () => {
    it('mints a 6-digit code with a bounded lifetime', () => {
      const { code, expiresAt } = beginPairing();
      expect(code).toMatch(/^\d{6}$/);
      expect(expiresAt).toBeGreaterThan(Date.now());
      cancelPairing();
    });

    it('rejects a wrong pairing code and closes the socket', () => {
      const { code } = beginPairing();
      const wrong = code === '000000' ? '111111' : '000000';
      const { f, client } = connectFake();
      feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code: wrong, identity: identityFor(EXT_ID) });

      expect(f.last('pair-fail')?.reason).toBe('bad_code');
      expect(f.last('pair-ok')).toBeUndefined();
      expect(f.closed).not.toBeNull();
      expect(client.authed).toBe(false);
      expect(isExtensionConnected()).toBe(false);
    });

    it('rejects a code whose window has expired', () => {
      __extChannelInternals.setTiming({ pairingTtlMs: -1 }); // already expired when minted
      const { code } = beginPairing();
      const { f, client } = connectFake();
      feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identityFor(EXT_ID) });

      expect(f.last('pair-fail')?.reason).toBe('no_pairing_window');
      expect(client.authed).toBe(false);
    });

    it('cuts off brute force and burns the code after a handful of attempts', () => {
      const { code } = beginPairing();
      const reasons: string[] = [];
      for (let i = 0; i < 8; i++) {
        const { f, client } = connectFake();
        feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code: String(i).padStart(6, '0'), identity: identityFor(EXT_ID) });
        reasons.push(f.last('pair-fail')?.reason ?? '');
      }
      // The budget is per pairing WINDOW, so reconnecting does not refill it.
      expect(reasons.filter((r) => r === 'bad_code').length).toBeLessThanOrEqual(5);
      expect(reasons.at(-1)).toBe('no_pairing_window');

      // …and the real code is dead even though it never expired.
      const { f, client } = connectFake();
      feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identityFor(EXT_ID) });
      expect(f.last('pair-ok')).toBeUndefined();
      expect(client.authed).toBe(false);
    });

    it('accepts the right code exactly once', () => {
      const { code } = beginPairing();
      const first = connectFake();
      feed(first.client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identityFor(EXT_ID) });
      expect(first.client.authed).toBe(true);
      expect(first.f.last('pair-ok')?.token).toMatch(/^[0-9a-f]{64}$/);

      const replay = connectFake();
      feed(replay.client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identityFor(EXT_ID) });
      expect(replay.client.authed).toBe(false);
      expect(replay.f.last('pair-fail')?.reason).toBe('no_pairing_window');
    });

    it('rejects an identity that does not match the vouched-for origin', () => {
      const { code } = beginPairing();
      const { f, client } = connectFake(EXT_ID);
      feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION, code, identity: identityFor(OTHER_EXT_ID) });
      expect(f.last('pair-fail')?.reason).toBe('identity_mismatch');
      expect(client.authed).toBe(false);
    });

    it('rejects a protocol version it does not speak, with a clear reason', () => {
      const { code } = beginPairing();
      const { f, client } = connectFake();
      feed(client, { t: 'pair', protocol: EXT_PROTOCOL_VERSION + 1, code, identity: identityFor(EXT_ID) });
      expect(f.last('pair-fail')?.reason).toMatch(/protocol mismatch/);
      expect(f.closed?.reason).toMatch(/protocol mismatch/);
      expect(client.authed).toBe(false);
    });
  });

  // ─── Reconnect with a token ────────────────────────────────────────────────

  describe('hello', () => {
    it('accepts a paired client returning with its token', () => {
      const { token } = pairFake();
      __extChannelInternals.reset(); // as if the app restarted: tokens live on disk
      __extChannelInternals.setTiming({ heartbeatMs: 60_000, authTimeoutMs: 60_000 });

      const { f, client } = connectFake();
      feed(client, { t: 'hello', protocol: EXT_PROTOCOL_VERSION, token, identity: identityFor(EXT_ID) });
      expect(client.authed).toBe(true);
      expect(f.last('ready')).toBeDefined();
      expect(isExtensionConnected()).toBe(true);
      expect(listExtensionClients()).toEqual([
        { clientId: client.id, identity: identityFor(EXT_ID), connectedAt: client.connectedAt },
      ]);
    });

    it('rejects an unknown token and closes', () => {
      pairFake();
      const { client } = connectFake();
      const f2 = fakeSocket();
      const stranger = __extChannelInternals.attachSocket(f2.socket, EXT_ID);
      feed(stranger, { t: 'hello', protocol: EXT_PROTOCOL_VERSION, token: 'f'.repeat(64), identity: identityFor(EXT_ID) });
      expect(stranger.authed).toBe(false);
      expect(f2.closed?.code).toBe(4001);
      expect(client.authed).toBe(false);
    });

    it("rejects another extension replaying a stolen token", () => {
      const { token } = pairFake(EXT_ID);
      const { f, client } = connectFake(OTHER_EXT_ID);
      feed(client, { t: 'hello', protocol: EXT_PROTOCOL_VERSION, token, identity: identityFor(OTHER_EXT_ID) });
      expect(client.authed).toBe(false);
      expect(f.closed?.code).toBe(4001);
    });

    it('drops an unauthenticated socket that tries to seed tabs or fake a result', () => {
      const { f, client } = connectFake();
      feed(client, { t: 'tabs', tabs: [{ tabId: 1, title: '', url: '', origin: '', writable: true, activatedAt: 0 }] });
      expect(client.tabs).toEqual([]);
      expect(f.closed?.code).toBe(4001);
      expect(listExtensionSurfaces()).toEqual([]);
    });
  });

  // ─── Client ids ────────────────────────────────────────────────────────────
  // The client id is half of every `tab:<clientId>.<tabId>` surface an agent
  // captures, so it has to name the BROWSER, not the socket. It used to be
  // handed out per connection — and since an MV3 service worker is evicted every
  // few minutes, the same browser came back as c1, then c4, and every surface
  // the agent was holding turned into a bare `no_extension`.

  describe('client ids', () => {
    it('hands the same id back to a browser whose service worker was evicted', async () => {
      const { client, token } = pairFake();
      const stable = client.id;
      pushTab(client, 1377716811);
      const surface = `tab:${stable}.1377716811`;
      expect(listExtensionSurfaces()[0].surface).toBe(surface);

      // Three evictions/reconnects in a row, each on a brand new socket.
      let back = { f: fakeSocket(), client };
      for (let i = 0; i < 3; i++) {
        __extChannelInternals.detachClient(back.client, 'socket closed');
        back = helloFake(token);
        expect(back.client.authed).toBe(true);
        expect(back.client.id).toBe(stable);
      }

      // The surface the agent captured at the start of its run still drives.
      pushTab(back.client, 1377716811);
      expect(listExtensionSurfaces()[0].surface).toBe(surface);
      const pending = runExtensionCommand(surface, { op: 'text' });
      feed(back.client, { t: 'result', reqId: back.f.last('cmd')?.reqId, ok: true, data: { text: 'still here' } });
      await expect(pending).resolves.toMatchObject({ ok: true, data: { text: 'still here' } });
    });

    it('persists the id with the pairing so it survives an app restart', () => {
      const { client, token } = pairFake();
      const stable = client.id;
      expect(readPairings().find((r) => r.extensionId === EXT_ID)?.clientId).toBe(stable);

      restartApp();
      expect(helloFake(token).client.id).toBe(stable);
    });

    it('gives two extensions different ids, stable regardless of who reconnects first', () => {
      writePairings([]);
      restartApp();

      const a = pairFake(EXT_ID);
      const b = pairFake(OTHER_EXT_ID);
      expect(a.client.id).toBe('c1');
      expect(b.client.id).toBe('c2');

      // Reconnect in the opposite order: the ids follow the browser, not the
      // order the sockets happened to land in.
      restartApp();
      expect(helloFake(b.token, OTHER_EXT_ID).client.id).toBe('c2');
      expect(helloFake(a.token, EXT_ID).client.id).toBe('c1');
    });

    it('adopts a pairing written before ids were persisted, without a re-pair', () => {
      const token = 'a'.repeat(64);
      writePairings([{ extensionId: EXT_ID, token, pairedAt: 1, browser: 'Chrome 141' }]); // no clientId
      restartApp();

      const { f, client } = helloFake(token);
      expect(client.authed).toBe(true); // the pairing itself must not be dropped
      expect(f.last('ready')).toBeDefined();
      expect(client.id).toMatch(/^c\d+$/);

      // The adoption is written back, so the id is stable from here on.
      const rec = readPairings().find((r) => r.extensionId === EXT_ID);
      expect(rec?.clientId).toBe(client.id);
      expect(rec?.token).toBe(token);
      restartApp();
      expect(helloFake(token).client.id).toBe(client.id);
    });

    it('keeps two browser profiles sharing one extension id separately drivable', async () => {
      writePairings([]);
      restartApp();
      const a = pairFake(EXT_ID);
      // A second Chrome profile runs the SAME extension, so it authenticates with
      // the same token — it is a second browser, not a replacement.
      const b = helloFake(a.token, EXT_ID);

      expect(b.client.authed).toBe(true);
      expect(a.client.gone).toBe(false);
      expect(a.f.closed).toBeNull();
      expect(a.client.id).toBe('c1');
      expect(b.client.id).toBe('c2');
      expect(listExtensionClients().map((c) => c.clientId)).toEqual(['c1', 'c2']);

      // Only the first one's id is persisted; the sibling's is per-connection.
      expect(readPairings()).toEqual([expect.objectContaining({ extensionId: EXT_ID, clientId: 'c1' })]);

      // Their tab ids are independent and DO collide — the surface id is the only
      // thing telling the two tabs apart.
      pushTab(a.client, 842);
      pushTab(b.client, 842);
      expect(listExtensionSurfaces().map((s) => s.surface)).toEqual(['tab:c1.842', 'tab:c2.842']);

      const toA = runExtensionCommand('tab:c1.842', { op: 'text' });
      expect(b.f.last('cmd')).toBeUndefined();
      feed(a.client, { t: 'result', reqId: a.f.last('cmd')?.reqId, ok: true, data: { text: 'profile A' } });
      await expect(toA).resolves.toMatchObject({ ok: true, data: { text: 'profile A' } });

      const toB = runExtensionCommand('tab:c2.842', { op: 'text' });
      feed(b.client, { t: 'result', reqId: b.f.last('cmd')?.reqId, ok: true, data: { text: 'profile B' } });
      await expect(toB).resolves.toMatchObject({ ok: true, data: { text: 'profile B' } });
    });

    it('reports a stale client id precisely instead of a bare no_extension', async () => {
      writePairings([]);
      restartApp();
      const first = pairFake(EXT_ID);
      pushTab(first.client, 1377716811);
      const stale = `tab:${first.client.id}.1377716811`;

      // That browser is gone; a different one now holds the same tab id.
      __extChannelInternals.detachClient(first.client, 'socket closed');
      const other = pairFake(OTHER_EXT_ID);
      pushTab(other.client, 1377716811);
      expect(other.client.id).not.toBe(first.client.id);

      const res = await runExtensionCommand(stale, { op: 'text' });
      expect(res).toMatchObject({ ok: false, error: EXT_ERRORS.noExtension });
      const message = String(res.data?.message);
      expect(message).toContain(`${first.client.id} is not connected`);
      expect(message).toContain('reconnected');
      expect(message).toContain(`tab:${other.client.id}.1377716811`);
      expect(message).toContain('bare tab:1377716811');
      expect(res.data?.surface).toBe(`tab:${other.client.id}.1377716811`);
      // Reported, never silently retargeted.
      expect(other.f.last('cmd')).toBeUndefined();

      // A tab no connected browser has: say what IS connected instead.
      const gone = await runExtensionCommand(`tab:${first.client.id}.999`, { op: 'text' });
      expect(gone).toMatchObject({ ok: false, error: EXT_ERRORS.noExtension });
      expect(String(gone.data?.message)).toContain(`no browser is connected as ${first.client.id}`);
      expect(gone.data?.clients).toEqual([other.client.id]);
    });
  });

  // ─── Surfaces ──────────────────────────────────────────────────────────────

  describe('surfaces', () => {
    it('exposes the last tab push as agent-targetable surfaces', () => {
      const { client } = pairFake();
      pushTab(client, 842);
      expect(listExtensionSurfaces()).toEqual([
        {
          surface: `tab:${client.id}.842`,
          clientId: client.id,
          tabId: 842,
          title: 'Local',
          url: 'http://localhost:3000/',
          origin: 'http://localhost:3000',
          writable: true,
          browser: 'Chrome 141',
        },
      ]);
    });
  });

  // ─── Commands ──────────────────────────────────────────────────────────────

  describe('runExtensionCommand', () => {
    it('correlates a result back to its request', async () => {
      const { f, client } = pairFake();
      pushTab(client, 842);

      const pending = runExtensionCommand(`tab:${client.id}.842`, { op: 'text' });
      const cmd = f.last('cmd');
      expect(cmd).toBeDefined();
      expect(cmd?.tabId).toBe(842);
      feed(client, { t: 'result', reqId: cmd?.reqId, ok: true, data: { text: 'hello' } });

      await expect(pending).resolves.toEqual({ ok: true, data: { text: 'hello' }, error: undefined });
    });

    it('ignores a result for a reqId it never issued', async () => {
      const { f, client } = pairFake();
      pushTab(client, 842);
      const pending = runExtensionCommand(`tab:${client.id}.842`, { op: 'text' });
      feed(client, { t: 'result', reqId: 'x999999', ok: true, data: { text: 'spoof' } });
      feed(client, { t: 'result', reqId: f.last('cmd')?.reqId, ok: true, data: { text: 'real' } });
      await expect(pending).resolves.toMatchObject({ ok: true, data: { text: 'real' } });
    });

    it('times out a command the extension never answers', async () => {
      __extChannelInternals.setTiming({ commandTimeoutMs: 20 });
      const { client } = pairFake();
      pushTab(client, 842);
      await expect(runExtensionCommand(`tab:${client.id}.842`, { op: 'text' }))
        .resolves.toEqual({ ok: false, error: EXT_ERRORS.timeout });
    });

    it('settles every pending request when the socket disconnects', async () => {
      __extChannelInternals.setTiming({ commandTimeoutMs: 60_000 });
      const { client } = pairFake();
      pushTab(client, 842);
      const a = runExtensionCommand(`tab:${client.id}.842`, { op: 'text' });
      const b = runExtensionCommand(`tab:${client.id}.842`, { op: 'html' });
      __extChannelInternals.detachClient(client, 'socket closed');
      // Never leave a caller awaiting a promise that can no longer resolve.
      await expect(Promise.all([a, b])).resolves.toEqual([
        { ok: false, error: EXT_ERRORS.noExtension },
        { ok: false, error: EXT_ERRORS.noExtension },
      ]);
      expect(isExtensionConnected()).toBe(false);
    });

    it('returns no_extension when nothing is paired', async () => {
      await expect(runExtensionCommand('tab:c1.842', { op: 'text' }))
        .resolves.toMatchObject({ ok: false, error: EXT_ERRORS.noExtension });
    });

    it('returns unknown_tab for a tab outside the registry', async () => {
      const { client } = pairFake();
      pushTab(client, 842);
      await expect(runExtensionCommand(`tab:${client.id}.999`, { op: 'text' }))
        .resolves.toMatchObject({ ok: false, error: EXT_ERRORS.unknownTab });
      await expect(runExtensionCommand('not-a-tab-surface', { op: 'text' }))
        .resolves.toMatchObject({ ok: false, error: EXT_ERRORS.unknownTab });
    });

    it('resolves the bare tab:842 form against the only connected client', async () => {
      const { f, client } = pairFake();
      pushTab(client, 842);
      const pending = runExtensionCommand('tab:842', { op: 'info' });
      feed(client, { t: 'result', reqId: f.last('cmd')?.reqId, ok: true, data: { url: 'http://localhost:3000/' } });
      await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('returns an ambiguity error for the bare tab:842 form with two clients', async () => {
      const a = pairFake(EXT_ID);
      const b = pairFake(OTHER_EXT_ID);
      pushTab(a.client, 842);
      pushTab(b.client, 842);

      const res = await runExtensionCommand('tab:842', { op: 'text' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(EXT_AMBIGUOUS_TAB);
      expect(a.f.last('cmd')).toBeUndefined();
      expect(b.f.last('cmd')).toBeUndefined();

      // Qualifying it resolves cleanly.
      const pending = runExtensionCommand(`tab:${b.client.id}.842`, { op: 'text' });
      expect(a.f.last('cmd')).toBeUndefined();
      feed(b.client, { t: 'result', reqId: b.f.last('cmd')?.reqId, ok: true, data: { text: 'b' } });
      await expect(pending).resolves.toMatchObject({ ok: true, data: { text: 'b' } });
    });
  });

  // ─── Settings gates ────────────────────────────────────────────────────────

  describe('settings gates', () => {
    it('refuses a write op while agentChromeWrite is off, without sending anything', async () => {
      setGates(true, false);
      const { f, client } = pairFake();
      pushTab(client, 842);

      for (const command of [
        { op: 'eval', js: '1+1' }, { op: 'navigate', url: 'https://example.com' },
        { op: 'back' }, { op: 'forward' }, { op: 'reload' },
      ] as const) {
        const res = await runExtensionCommand(`tab:${client.id}.842`, command);
        expect(res, command.op).toMatchObject({ ok: false, error: EXT_ERRORS.writeDenied });
      }
      expect(f.last('cmd')).toBeUndefined();
    });

    it('still allows the read-only ops while agentChromeWrite is off', async () => {
      setGates(true, false);
      const { f, client } = pairFake();
      pushTab(client, 842);
      const pending = runExtensionCommand(`tab:${client.id}.842`, { op: 'screenshot' });
      const cmd = f.last('cmd');
      expect(cmd?.command).toEqual({ op: 'screenshot' });
      feed(client, { t: 'result', reqId: cmd?.reqId, ok: true, data: { pngBase64: 'x' } });
      await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('sends a write op once agentChromeWrite is on', async () => {
      setGates(true, true);
      const { f, client } = pairFake();
      pushTab(client, 842);
      const pending = runExtensionCommand(`tab:${client.id}.842`, { op: 'navigate', url: 'https://example.com' });
      const cmd = f.last('cmd');
      expect(cmd?.command).toEqual({ op: 'navigate', url: 'https://example.com' });
      feed(client, { t: 'result', reqId: cmd?.reqId, ok: true, data: { url: 'https://example.com/' } });
      await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('refuses everything while agentChromeControl is off', async () => {
      const { f, client } = pairFake();
      pushTab(client, 842);
      setGates(false, true); // write on but control off must still refuse
      for (const command of [{ op: 'info' }, { op: 'text' }, { op: 'eval', js: '1' }] as const) {
        const res = await runExtensionCommand(`tab:${client.id}.842`, command);
        expect(res, command.op).toMatchObject({ ok: false, error: EXT_DISABLED });
      }
      expect(f.last('cmd')).toBeUndefined();
    });
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

  describe('heartbeat', () => {
    it('pings on a timer and drops a client that misses two consecutive pongs', async () => {
      __extChannelInternals.setTiming({ heartbeatMs: 5 });
      const { f, client } = pairFake();
      await vi.waitFor(() => expect(f.closed).not.toBeNull(), { timeout: 1_000 });
      expect(f.sent.filter((m) => m.t === 'ping').length).toBe(2);
      expect(f.closed?.reason).toBe('heartbeat lost');
      expect(client.authed && !client.gone).toBe(false);
    });

    it('keeps a client that answers its pings', async () => {
      __extChannelInternals.setTiming({ heartbeatMs: 5 });
      const { f, client } = pairFake();
      const answer = setInterval(() => feed(client, { t: 'pong' }), 2);
      await new Promise((r) => setTimeout(r, 60));
      clearInterval(answer);
      expect(f.closed).toBeNull();
      expect(client.gone).toBe(false);
    });
  });
});
