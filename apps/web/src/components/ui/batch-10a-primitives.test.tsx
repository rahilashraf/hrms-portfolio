import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { DataTable, type DataTableColumn } from './data-table';
import { PageContainer, pageContainerClass } from './page-container';
import { StatusBadge, statusTone } from './status-badge';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  status: string;
  amount: string;
}

const rows: Row[] = [
  { id: 'r1', name: 'Avery Payee', status: 'PENDING', amount: '1,200.00' },
  { id: 'r2', name: 'Blair Benefits', status: 'APPROVED', amount: '980.50' },
];

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Employee', rowHeader: true, cell: (row) => row.name, cardLabel: false },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <StatusBadge status={row.status} />,
  },
  { key: 'amount', header: 'Amount', align: 'right', cell: (row) => row.amount },
];

describe('Batch 10A PageContainer', () => {
  it('renders one of four widths, with the same frame for every state of a page', () => {
    expect(pageContainerClass()).toBe('mx-auto w-full max-w-5xl px-5 py-10');
    expect(pageContainerClass('narrow')).toContain('max-w-3xl');
    expect(pageContainerClass('wide')).toContain('max-w-6xl');
    expect(pageContainerClass('full')).toContain('max-w-7xl');
    render(
      <PageContainer width="wide" as="section" className="space-y-4">
        content
      </PageContainer>,
    );
    const frame = screen.getByText('content');
    expect(frame.tagName).toBe('SECTION');
    expect(frame).toHaveClass('max-w-6xl', 'space-y-4', 'mx-auto', 'w-full');
  });
});

describe('Batch 10A StatusBadge', () => {
  it('always shows words, and the same status always has the same tone', async () => {
    const { container } = render(
      <div>
        <StatusBadge status="CHANGES_REQUESTED" />
        <StatusBadge status="approved" />
        <StatusBadge status="SOMETHING_NEW" />
        <StatusBadge status="PAID" label="Paid out" tone="info" />
      </div>,
    );
    expect(screen.getByText('Changes Requested')).toHaveAttribute(
      'data-status',
      'CHANGES_REQUESTED',
    );
    expect(statusTone('CHANGES_REQUESTED')).toBe('warning');
    expect(statusTone('approved')).toBe('success');
    expect(statusTone('REJECTED')).toBe('danger');
    expect(statusTone('ARCHIVED')).toBe('neutral');
    expect(statusTone('SUBMITTED')).toBe('info');
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
    expect(screen.getByText('Approved')).toHaveClass('bg-emerald-100');
    expect(screen.getByText('Something New')).toHaveClass('bg-slate-100');
    // An explicit label and tone win.
    expect(screen.getByText('Paid out')).toHaveClass('bg-sky-100');
    await expectNoAxeViolations(container);
  });
});

describe('Batch 10A DataTable', () => {
  it('is a named, keyboard-focusable scroll region with column and row headers', async () => {
    const { container } = render(
      <DataTable label="Pay statements" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    const region = screen.getByRole('region', { name: 'Pay statements' });
    expect(region).toHaveAttribute('tabindex', '0');
    const table = within(region).getByRole('table', { name: 'Pay statements' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Employee', 'Status', 'Amount']);
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col');
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders.map((h) => h.textContent)).toEqual(['Avery Payee', 'Blair Benefits']);
    for (const header of rowHeaders) expect(header).toHaveAttribute('scope', 'row');
    expect(within(table).getByText('1,200.00')).toHaveClass('text-right', 'tabular-nums');
    // Keyboard: the region takes focus (arrow keys then scroll it).
    region.focus();
    expect(region).toHaveFocus();
    await expectNoAxeViolations(container);
  });

  it('renders the shared loading and empty states in the same place', () => {
    const { rerender } = render(
      <DataTable
        label="Runs"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        loading
        loadingLabel="Loading runs…"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs…');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    rerender(
      <DataTable
        label="Runs"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty="No runs yet."
      />,
    );
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('optionally offers phone cards (label/value pairs) alongside the table', async () => {
    const { container } = render(
      <DataTable
        label="Pay statements"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={(r) => (r.status === 'PENDING' ? 'bg-amber-50' : undefined)}
        stacked
      />,
    );
    const cards = screen.getByRole('list', { name: 'Pay statements' });
    expect(cards).toHaveClass('sm:hidden');
    const items = within(cards).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveClass('bg-amber-50');
    expect(within(items[0]!).getByText('Avery Payee')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Amount')).toBeInTheDocument();
    expect(within(items[0]!).getByText('1,200.00')).toBeInTheDocument();
    // The table is still there for larger screens.
    expect(screen.getByRole('region', { name: 'Pay statements' }).parentElement).toHaveClass(
      'hidden',
      'sm:block',
    );
    await expectNoAxeViolations(container);
  });

  it('passes clicks through cell content (actions stay the caller’s)', () => {
    let opened = '';
    render(
      <DataTable
        label="People"
        columns={[
          {
            key: 'open',
            header: 'Actions',
            cell: (row: Row) => (
              <button type="button" onClick={() => (opened = row.id)}>
                Open {row.name}
              </button>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Blair Benefits' }));
    expect(opened).toBe('r2');
  });
});

describe('DataTable column colours (Batch 10C)', () => {
  it("keeps a column's own text colour instead of the default", () => {
    render(
      <DataTable
        label="Colours"
        rows={[{ id: 'a' }]}
        rowKey={(row) => row.id}
        columns={[
          { key: 'plain', header: 'Plain', cell: () => 'plain' },
          { key: 'muted', header: 'Muted', className: 'text-slate-600', cell: () => 'muted' },
          {
            key: 'brand',
            header: 'Brand',
            className: 'text-[var(--hrms-accent-text)]',
            cell: () => 'brand',
          },
          { key: 'small', header: 'Small', className: 'text-xs text-right', cell: () => 'small' },
        ]}
      />,
    );
    expect(screen.getByText('plain')).toHaveClass('text-slate-800');
    expect(screen.getByText('muted')).toHaveClass('text-slate-600');
    expect(screen.getByText('muted')).not.toHaveClass('text-slate-800');
    expect(screen.getByText('brand')).not.toHaveClass('text-slate-800');
    // A size or alignment is not a colour: the default colour stays.
    expect(screen.getByText('small')).toHaveClass('text-slate-800');
  });
});
