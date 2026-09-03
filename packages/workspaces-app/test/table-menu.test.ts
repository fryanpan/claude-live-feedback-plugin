import { describe, expect, it } from 'vitest';
import { tableMenuItems } from '../src/table-menu.ts';

/**
 * The table button opens a popover whose contents depend on where the cursor
 * is. Outside a table you can only insert one; inside a table the row/column
 * and delete operations become available. These pin that branching so the UI
 * never offers "delete row" when there's no table to act on.
 */
describe('tableMenuItems', () => {
  it('offers only insert when the cursor is not in a table', () => {
    const items = tableMenuItems(false);
    expect(items).toHaveLength(1);
    expect(items[0]?.cmd).toBe('insertTable');
  });

  it('offers insert plus row/column/delete ops inside a table', () => {
    const items = tableMenuItems(true);
    const cmds = items.map((i) => i.cmd);
    expect(cmds).toEqual([
      'insertTable',
      'addRowBefore',
      'addRowAfter',
      'addColumnBefore',
      'addColumnAfter',
      'deleteRow',
      'deleteColumn',
      'deleteTable',
    ]);
  });

  it('marks the delete operations as dangerous', () => {
    const danger = tableMenuItems(true)
      .filter((i) => i.danger)
      .map((i) => i.cmd);
    expect(danger).toEqual(['deleteRow', 'deleteColumn', 'deleteTable']);
  });
});
