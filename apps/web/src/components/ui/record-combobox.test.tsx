import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { PickerOption } from '../../lib/pickers/sources';
import type { RecordPage, RecordSource } from '../../lib/pickers/use-record-search';
import { expectNoAxeViolations } from '../../test/axe';
import { RecordCombobox } from './record-combobox';

const ada: PickerOption = { id: 'emp-1', label: 'Ada Lovelace', description: 'E-1 · Analyst' };
const grace: PickerOption = { id: 'emp-2', label: 'Grace Hopper', description: 'E-2 · Engineer' };
const alan: PickerOption = {
  id: 'emp-3',
  label: 'Alan Turing',
  disabledReason: 'Not activated yet',
};

function Harness({
  search,
  manual = false,
}: {
  search: RecordSource<PickerOption>['search'];
  manual?: boolean;
}) {
  const source = useMemo(() => ({ search }), [search]);
  const [value, setValue] = useState('');
  return (
    <form aria-label="Pick">
      <RecordCombobox
        label="Employee"
        hint="Name or employee number."
        source={source}
        value={value}
        onChange={(id) => setValue(id)}
        {...(manual ? { manualEntry: { label: 'Employee ID' } } : {})}
      />
      <output aria-label="Chosen">{value || 'none'}</output>
    </form>
  );
}

afterEach(cleanup);

describe('RecordCombobox', () => {
  it('browses on focus and chooses with the keyboard, skipping nothing it must not', async () => {
    const search = vi.fn(async (): Promise<RecordPage<PickerOption>> => ({
      items: [ada, alan, grace],
      next: null,
    }));
    const { container } = render(<Harness search={search} />);
    const input = screen.getByRole('combobox', { name: 'Employee' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAccessibleDescription('Name or employee number.');
    await expectNoAxeViolations(container);

    fireEvent.focus(input);
    const list = await screen.findByRole('listbox', { name: 'Search results' });
    expect(await within(list).findAllByRole('option')).toHaveLength(3);
    expect(search).toHaveBeenCalledWith('', null);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('3 results.')).toBeInTheDocument();
    await expectNoAxeViolations(container);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const first = within(list).getAllByRole('option')[0]!;
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // The disabled option is announced as such and Enter does nothing on it.
    const disabled = within(list).getByRole('option', { name: /Alan Turing/ });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).toHaveTextContent('Not activated yet');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('Chosen')).toHaveTextContent('none');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('Chosen')).toHaveTextContent('emp-2');
    expect(input).toHaveValue('Grace Hopper');
    expect(input).toHaveAttribute('aria-expanded', 'false');

    // Clearing empties the value and returns focus to the input.
    fireEvent.click(screen.getByRole('button', { name: 'Clear Employee' }));
    expect(screen.getByLabelText('Chosen')).toHaveTextContent('none');
    expect(input).toHaveFocus();
  });

  it('searches once per pause in typing and never shows an older, slower answer', async () => {
    let resolveSlow: (page: RecordPage<PickerOption>) => void = () => undefined;
    const search = vi.fn((query: string) => {
      if (query === 'ad') {
        return new Promise<RecordPage<PickerOption>>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve({ items: query === 'gra' ? [grace] : [ada, grace], next: null });
    });
    render(<Harness search={search} />);
    const input = screen.getByRole('combobox', { name: 'Employee' });
    fireEvent.focus(input);
    await screen.findByRole('listbox');
    search.mockClear();

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ad' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('ad', null));
    expect(search).not.toHaveBeenCalledWith('a', null);

    fireEvent.change(input, { target: { value: 'gra' } });
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1),
    );
    // The earlier, slower request finishes last: it must not replace the newer results.
    await act(async () => resolveSlow({ items: [ada], next: null }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Grace Hopper'),
    ]);
  });

  it('loads the next page from the last option and closes on Escape', async () => {
    const search = vi.fn(async (_query: string, cursor: string | null) =>
      cursor ? { items: [grace], next: null } : { items: [ada], next: 'emp-1' },
    );
    render(<Harness search={search} />);
    const input = screen.getByRole('combobox', { name: 'Employee' });
    fireEvent.focus(input);
    const more = await screen.findByRole('option', { name: 'Load more results' });
    expect(screen.getByText('1 result, more available.')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', more.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(search).toHaveBeenCalledWith('', 'emp-1'));
    expect(await screen.findByRole('option', { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Load more results' })).not.toBeInTheDocument();

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
  });

  it('offers typing the ID when the search is not permitted', async () => {
    const search = vi.fn(async () => {
      throw new AuthApiError('forbidden', 403);
    });
    const { container } = render(<Harness search={search} manual />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Employee' }));
    const typed = await screen.findByLabelText('Employee ID');
    expect(screen.getAllByText('You cannot search these records here.').length).toBeGreaterThan(0);
    fireEvent.change(typed, { target: { value: ' 00000000-0000-4000-8000-000000000001 ' } });
    expect(screen.getByLabelText('Chosen')).toHaveTextContent(
      '00000000-0000-4000-8000-000000000001',
    );
    await expectNoAxeViolations(container);
  });
});
