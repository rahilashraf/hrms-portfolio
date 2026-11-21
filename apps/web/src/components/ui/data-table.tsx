import type { Key, ReactNode } from 'react';
import { EmptyState, LoadingState, TableScroll } from './states';

/**
 * Batch 10A — a typed data table on top of `TableScroll`.
 *
 * - The table always sits in a named, keyboard-focusable scroll region (`label`), so a table wider
 *   than the screen scrolls inside the page instead of widening it, and keyboard users can scroll
 *   it (axe `scrollable-region-focusable`).
 * - Column headers carry `scope="col"`; a column marked `rowHeader` renders `th scope="row"` so
 *   screen readers name each row.
 * - `loading` and an empty `rows` render the shared loading and empty states in the same frame.
 * - `stacked`: below the `sm` breakpoint each row is also offered as a card of label/value pairs
 *   (the table is then hidden on phones, the cards on larger screens). Use it only where cards
 *   are materially easier on a phone; scrolling is the default.
 *
 * Presentation only: what rows and actions are shown is decided by the caller from the API's
 * answers (row action flags), never by this component.
 */
export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  cell(row: T, index: number): ReactNode;
  align?: 'left' | 'right';
  /** This column names the row (rendered as `<th scope="row">`). */
  rowHeader?: boolean;
  /** Extra classes for this column's cells. */
  className?: string;
  /** In stacked cards, the label (defaults to the header) or `false` to leave it out. */
  cardLabel?: ReactNode | false;
}

/**
 * Batch 10C: whether a column's classes already set a text colour (any `text-*` utility that is
 * not a size, alignment or wrapping utility), so the default colour is left out.
 */
const NOT_COLOR =
  /^text-(xs|sm|base|lg|[2-9]?xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
function hasTextColor(className: string | undefined): boolean {
  return (className ?? '')
    .split(/\s+/)
    .map((token) => token.split(':').pop() ?? '')
    .some((token) => token.startsWith('text-') && !NOT_COLOR.test(token));
}

export function DataTable<T>({
  label,
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  rowLabel,
  loading = false,
  loadingLabel = 'Loading…',
  empty = 'Nothing to show.',
  stacked = false,
  minWidth,
  bare = false,
}: {
  /** The scroll region's and (unless `caption` is given) the table's accessible name. */
  label: string;
  /** A visible-to-screen-readers caption; defaults to `label`. */
  caption?: ReactNode;
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: readonly T[];
  rowKey(row: T, index: number): Key;
  rowClassName?(row: T, index: number): string | undefined;
  /**
   * Batch 10E-2: an accessible name for each row (e.g. "Version 2"), for tables whose rows were
   * already named that way; by default a row is named by its cells.
   */
  rowLabel?(row: T, index: number): string | undefined;
  loading?: boolean;
  loadingLabel?: string;
  /** Shown when `rows` is empty: text or a full `EmptyState`. */
  empty?: ReactNode;
  stacked?: boolean;
  /**
   * Batch 10B: a minimum table width (e.g. `min-w-[760px]`) for wide tables whose columns should
   * not squeeze on phones; the region then scrolls horizontally (it is keyboard-focusable).
   */
  minWidth?: `min-w-[${string}]`;
  /** Batch 10B: no frame of its own (for a table inside an already bordered panel). */
  bare?: boolean;
}) {
  if (loading) return <LoadingState label={loadingLabel} />;
  if (rows.length === 0)
    return typeof empty === 'string' ? <EmptyState>{empty}</EmptyState> : <>{empty}</>;

  const alignClass = (column: DataTableColumn<T>) =>
    column.align === 'right' ? 'text-right' : 'text-left';

  const table = (
    <TableScroll label={label} bare={bare}>
      <table className={`${minWidth ?? 'min-w-full'} w-full divide-y divide-slate-200 text-sm`}>
        <caption className="sr-only">{caption ?? label}</caption>
        <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`px-4 py-2 ${alignClass(column)}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className={rowClassName?.(row, index)}
              aria-label={rowLabel?.(row, index)}
            >
              {columns.map((column) => {
                // Batch 10C: a column's own text colour wins over the default.
                const color = hasTextColor(column.className) ? '' : 'text-slate-800';
                const classes = `px-4 py-2 ${color} ${alignClass(column)} ${
                  column.align === 'right' ? 'tabular-nums' : ''
                } ${column.className ?? ''}`.trim();
                return column.rowHeader ? (
                  <th key={column.key} scope="row" className={`${classes} font-medium`}>
                    {column.cell(row, index)}
                  </th>
                ) : (
                  <td key={column.key} className={classes}>
                    {column.cell(row, index)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );

  if (!stacked) return table;
  return (
    <>
      <ul aria-label={label} className="space-y-3 sm:hidden">
        {rows.map((row, index) => (
          <li
            key={rowKey(row, index)}
            className={`rounded-xl border border-slate-200 bg-white p-4 ${rowClassName?.(row, index) ?? ''}`.trim()}
          >
            {columns
              .filter((column) => column.cardLabel === false)
              .map((column) => (
                <div key={column.key} className="mb-2 min-w-0 font-medium text-slate-900">
                  {column.cell(row, index)}
                </div>
              ))}
            <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-sm">
              {columns
                .filter((column) => column.cardLabel !== false)
                .map((column) => (
                  <div key={column.key} className="contents">
                    <dt className="text-slate-600">{column.cardLabel ?? column.header}</dt>
                    <dd className="min-w-0 break-words text-slate-900">
                      {column.cell(row, index)}
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">{table}</div>
    </>
  );
}
