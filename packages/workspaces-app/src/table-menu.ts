/**
 * Table editing is powered by @tiptap/extension-table (prosemirror-tables) —
 * this module is just the popover's item list. `cmd` names the Tiptap chain
 * command wired up in app.ts; splitting the list out keeps the "which ops are
 * available where" logic pure and testable.
 */
export interface TableMenuItem {
  label: string;
  cmd:
    | 'insertTable'
    | 'addRowBefore'
    | 'addRowAfter'
    | 'addColumnBefore'
    | 'addColumnAfter'
    | 'deleteRow'
    | 'deleteColumn'
    | 'deleteTable';
  /** Destructive op — styled distinctly in the menu. */
  danger?: boolean;
}

/**
 * Items to show in the table popover. Outside a table only "Insert table" is
 * offered; inside one, the row/column and delete operations become available.
 */
export function tableMenuItems(inTable: boolean): TableMenuItem[] {
  const insert: TableMenuItem = { label: 'Insert table', cmd: 'insertTable' };
  if (!inTable) return [insert];
  return [
    insert,
    { label: 'Row above', cmd: 'addRowBefore' },
    { label: 'Row below', cmd: 'addRowAfter' },
    { label: 'Column left', cmd: 'addColumnBefore' },
    { label: 'Column right', cmd: 'addColumnAfter' },
    { label: 'Delete row', cmd: 'deleteRow', danger: true },
    { label: 'Delete column', cmd: 'deleteColumn', danger: true },
    { label: 'Delete table', cmd: 'deleteTable', danger: true },
  ];
}
