import { describe, it, expect } from 'vitest';
import { groupConnections } from './useConnectionGroups';
import type { SavedConnection } from '../../shared/types';

const conn = (id: string, group?: string): SavedConnection => ({
  id, label: id, host: 'h', port: 22, username: 'u', authMethod: 'password', group,
});

describe('groupConnections', () => {
  it('follows the group order, appends unknown groups, and puts ungrouped last', () => {
    const sections = groupConnections(
      [conn('1'), conn('2', 'b'), conn('3', 'z'), conn('4', 'a'), conn('5', 'b')],
      ['a', 'b'],
    );
    expect(sections.map((s) => [s.name, s.connections.map((c) => c.id)])).toEqual([
      ['a', ['4']],
      ['b', ['2', '5']],
      ['z', ['3']],
      [null, ['1']],
    ]);
  });

  it('drops empty groups unless asked to keep them, and omits an empty ungrouped section', () => {
    expect(groupConnections([conn('1', 'a')], ['a', 'empty']).map((s) => s.name)).toEqual(['a']);
    expect(groupConnections([conn('1', 'a')], ['a', 'empty'], true).map((s) => s.name)).toEqual(['a', 'empty']);
  });
});
