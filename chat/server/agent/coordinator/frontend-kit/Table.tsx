import type { ReactNode } from 'react';

/** Column definition: header + cell renderer. */
export interface Column<T> {
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  width?: string | number;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  emptyMessage?: string;
}

/** Styled data table. For empty `rows` renders the empty message row. */
export function DataTable<T>({ columns, rows, rowKey, emptyMessage = 'Nothing here yet.' }: DataTableProps<T>) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{ textAlign: 'left', padding: '10px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--kit-text-muted)', borderBottom: '1px solid var(--kit-border)', width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} style={{ padding: 24, textAlign: 'center', color: 'var(--kit-text-muted)' }}>{emptyMessage}</td></tr>
          )}
          {rows.map((row, ri) => (
            <tr key={rowKey(row, ri)}>
              {columns.map((c, ci) => (
                <td key={ci} style={{ padding: '10px 12px', borderBottom: '1px solid var(--kit-border)' }}>{c.cell(row, ri)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
