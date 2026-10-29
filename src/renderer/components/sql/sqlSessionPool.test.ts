import { describe, expect, it } from 'vitest';
import { SqlSessionPool, sessionKey } from './sqlSessionPool';
import type { SQLConnectionInfo } from '../../../shared/types';

function makeFake(limit?: number) {
  const connects: string[] = [];
  const disconnects: string[] = [];
  let n = 0;
  const pool = new SqlSessionPool({
    limit,
    connect: async (savedId, database) => {
      connects.push(`${savedId}/${database ?? '(default)'}`);
      n += 1;
      return {
        id: `sess-${n}`,
        // A connect with no database lands on the connection's own default.
        database: database ?? 'default-db',
        connectionName: savedId,
      } as unknown as SQLConnectionInfo;
    },
    disconnect: async (id) => { disconnects.push(id); },
  });
  return { pool, connects, disconnects };
}

describe('sessionKey', () => {
  it('separates databases and trims', () => {
    expect(sessionKey('a', 'shop')).toBe('a::shop');
    expect(sessionKey('a', '  shop ')).toBe('a::shop');
    expect(sessionKey('a', null)).toBe('a::');
    expect(sessionKey('a', 'shop')).not.toBe(sessionKey('b', 'shop'));
  });
});

describe('SqlSessionPool', () => {
  it('reuses a session instead of reconnecting, and never disconnects on switch', async () => {
    const { pool, connects, disconnects } = makeFake();

    const first = await pool.acquire('a', 'shop');
    expect(first.reused).toBe(false);

    await pool.acquire('a', 'analytics'); // switch database
    await pool.acquire('b', 'crm');       // switch connection
    const back = await pool.acquire('a', 'shop'); // switch back

    expect(back.reused).toBe(true);
    expect(back.info.id).toBe(first.info.id);
    expect(connects).toEqual(['a/shop', 'a/analytics', 'b/crm']);
    expect(disconnects).toEqual([]);
  });

  it('reaches a default-database session by its real name too', async () => {
    const { pool, connects } = makeFake();
    const opened = await pool.acquire('a', null);
    expect(opened.info.database).toBe('default-db');

    const byName = await pool.acquire('a', 'default-db');
    expect(byName.reused).toBe(true);
    expect(byName.info.id).toBe(opened.info.id);
    expect(connects).toHaveLength(1);
  });

  it('shares one in-flight connect between concurrent acquires', async () => {
    const { pool, connects } = makeFake();
    const [x, y] = await Promise.all([pool.acquire('a', 'shop'), pool.acquire('a', 'shop')]);
    expect(connects).toHaveLength(1);
    expect(x.info.id).toBe(y.info.id);
  });

  it('evicts the least recently used session, never the protected one', async () => {
    const { pool, disconnects } = makeFake(2);
    const shop = await pool.acquire('a', 'shop');
    pool.protect(shop.info.id);
    await pool.acquire('a', 'analytics');
    await pool.acquire('a', 'crm');

    expect(disconnects).toEqual(['sess-2']); // analytics, the oldest unprotected
    expect(pool.peek('a', 'shop')?.id).toBe(shop.info.id);
    expect(pool.peek('a', 'analytics')).toBeNull();
    expect(pool.list().map((s) => s.database)).toEqual(['crm', 'shop']);
  });

  it('counts a reuse as recent, so the freshly used session survives', async () => {
    const { pool, disconnects } = makeFake(2);
    await pool.acquire('a', 'one');
    await pool.acquire('a', 'two');
    await pool.acquire('a', 'one'); // 'two' is now the least recently used
    await pool.acquire('a', 'three');

    expect(disconnects).toEqual(['sess-2']);
    expect(pool.peek('a', 'one')).not.toBeNull();
  });

  it('drops every database of one saved connection on disconnect', async () => {
    const { pool, disconnects } = makeFake();
    await pool.acquire('a', 'shop');
    await pool.acquire('a', 'analytics');
    await pool.acquire('b', 'crm');

    await pool.dropSaved('a');
    expect(disconnects.sort()).toEqual(['sess-1', 'sess-2']);
    expect(pool.peek('a', 'shop')).toBeNull();
    expect(pool.peek('b', 'crm')).not.toBeNull();
  });

  it('forgets a dead session so the next acquire dials a fresh one', async () => {
    const { pool, connects } = makeFake();
    const first = await pool.acquire('a', 'shop');
    await pool.drop(first.info.id);

    const second = await pool.acquire('a', 'shop');
    expect(second.reused).toBe(false);
    expect(second.info.id).not.toBe(first.info.id);
    expect(connects).toEqual(['a/shop', 'a/shop']);
  });

  it('closes everything when the pane goes away', async () => {
    const { pool, disconnects } = makeFake();
    await pool.acquire('a', 'shop');
    await pool.acquire('b', 'crm');

    await pool.closeAll();
    expect(disconnects.sort()).toEqual(['sess-1', 'sess-2']);
    expect(pool.list()).toEqual([]);
  });

  it('does not leave a half-registered session behind when connecting fails', async () => {
    let fail = true;
    const pool = new SqlSessionPool({
      connect: async () => {
        if (fail) throw new Error('refused');
        return { id: 'sess-ok', database: 'shop' } as unknown as SQLConnectionInfo;
      },
      disconnect: async () => {},
    });

    await expect(pool.acquire('a', 'shop')).rejects.toThrow('refused');
    expect(pool.list()).toEqual([]);

    fail = false;
    await expect(pool.acquire('a', 'shop')).resolves.toMatchObject({ reused: false });
  });
});
