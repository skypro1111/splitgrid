import { describe, expect, it } from 'vitest';
import {
  makeObjectTabId,
  planContextPick,
  resolveSchema,
  resolveTargetDatabase,
  type ContextSelection,
} from './sqlContext';

const live = (over: Partial<ContextSelection> = {}): ContextSelection => ({
  selectedSavedId: 'a',
  connectedSavedId: 'a',
  connected: true,
  database: 'shop',
  schema: 'public',
  ...over,
});

describe('resolveTargetDatabase', () => {
  it('uses the explicitly requested database', () => {
    expect(resolveTargetDatabase('analytics', 'shop')).toBe('analytics');
  });

  it('falls back to the target connection’s own saved database', () => {
    expect(resolveTargetDatabase(null, 'shop')).toBe('shop');
    expect(resolveTargetDatabase('   ', 'shop')).toBe('shop');
    expect(resolveTargetDatabase(undefined, 'shop')).toBe('shop');
  });

  it('is empty when neither side names a database', () => {
    expect(resolveTargetDatabase(null, undefined)).toBe('');
    expect(resolveTargetDatabase('', '')).toBe('');
  });
});

describe('resolveSchema', () => {
  const schemas = [{ schema: 'public', isDefault: true }, { schema: 'billing' }];

  it('keeps a preferred schema that exists here', () => {
    expect(resolveSchema(schemas, 'billing')).toBe('billing');
  });

  it('drops a preferred schema from another database', () => {
    expect(resolveSchema(schemas, 'legacy')).toBe('public');
  });

  it('falls back to the default, then the first, then nothing', () => {
    expect(resolveSchema(schemas)).toBe('public');
    expect(resolveSchema([{ schema: 'dbo' }], null)).toBe('dbo');
    expect(resolveSchema([], 'public')).toBe('');
  });
});

describe('planContextPick', () => {
  it('connects to another connection’s OWN database, not the current one', () => {
    expect(planContextPick({ connectionId: 'b', database: '', schema: '' }, live()))
      .toEqual({ action: 'connect', savedId: 'b', database: null, schema: null });
  });

  it('connects once, carrying the picked database and schema', () => {
    expect(planContextPick({ connectionId: 'b', database: 'crm', schema: 'billing' }, live()))
      .toEqual({ action: 'connect', savedId: 'b', database: 'crm', schema: 'billing' });
  });

  it('reconnects when only the database changes on the live connection', () => {
    expect(planContextPick({ connectionId: 'a', database: 'analytics', schema: '' }, live()))
      .toEqual({ action: 'connect', savedId: 'a', database: 'analytics', schema: null });
  });

  it('switches schema without reconnecting', () => {
    expect(planContextPick({ connectionId: 'a', database: 'shop', schema: 'billing' }, live()))
      .toEqual({ action: 'schema', schema: 'billing' });
  });

  it('connects when the selected connection is not live', () => {
    const idle = live({ connectedSavedId: null, connected: false });
    expect(planContextPick({ connectionId: '', database: '', schema: '' }, idle))
      .toEqual({ action: 'connect', savedId: 'a', database: null, schema: null });
  });

  it('does nothing when the pick matches the live context', () => {
    expect(planContextPick({ connectionId: 'a', database: 'shop', schema: 'public' }, live()))
      .toEqual({ action: 'none' });
  });

  it('does nothing without any connection to target', () => {
    expect(planContextPick({ connectionId: '', database: 'x', schema: '' }, live({ selectedSavedId: null })))
      .toEqual({ action: 'none' });
  });
});

describe('makeObjectTabId', () => {
  it('scopes a table tab to its connection and database', () => {
    expect(makeObjectTabId('t', 'a', 'shop', 'public', 'users')).toBe('t:a:shop:public.users');
  });

  it('gives the same table in another database a distinct tab', () => {
    expect(makeObjectTabId('t', 'a', 'shop', 'public', 'users'))
      .not.toBe(makeObjectTabId('t', 'a', 'analytics', 'public', 'users'));
    expect(makeObjectTabId('t', 'a', 'shop', 'public', 'users'))
      .not.toBe(makeObjectTabId('t', 'b', 'shop', 'public', 'users'));
  });

  it('keeps structure tabs separate from table tabs', () => {
    expect(makeObjectTabId('s', 'a', 'shop', 'public', 'users'))
      .not.toBe(makeObjectTabId('t', 'a', 'shop', 'public', 'users'));
  });
});
