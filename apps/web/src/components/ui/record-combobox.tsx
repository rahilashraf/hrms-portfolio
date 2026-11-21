'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PickerOption } from '../../lib/pickers/sources';
import { useRecordSearch, type RecordSource } from '../../lib/pickers/use-record-search';
import { buttonClass } from './button';
import { FormField } from './form/form-field';
import { inputClass } from './tokens';

const LOAD_MORE = '__load-more__';

/**
 * Batch 3B — a searchable record picker (WAI-ARIA combobox with a listbox popup):
 *
 * - type to search the server (debounced; only the latest response counts), browse with Arrow
 *   Down/Up, choose with Enter or a click, close with Escape, leave with Tab;
 * - more results load from the last option ("Load more results") with the cursor;
 * - loading, the number of results, no results and errors are announced politely;
 * - the chosen record shows as the input's text and can be cleared;
 * - `manualEntry` adds "Enter an ID instead" for users who may not search these records (it
 *   opens by itself when the search is refused). The server still checks whatever is sent.
 *
 * The value is the chosen record's id ('' for none); `selected` is how to show a value chosen
 * before (e.g. when editing).
 */
export function RecordCombobox({
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  className,
  source,
  value,
  selected = null,
  onChange,
  placeholder = 'Type to search',
  noResultsText = 'No matches.',
  manualEntry,
  disabled = false,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  /** Keep the label for assistive technology only (e.g. in a table row). */
  hideLabel?: boolean;
  className?: string;
  source: RecordSource<PickerOption>;
  value: string;
  selected?: PickerOption | null;
  onChange(id: string, option: PickerOption | null): void;
  placeholder?: string;
  noResultsText?: string;
  manualEntry?: { label: string; hint?: string };
  disabled?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(-1);
  const [chosen, setChosen] = useState<PickerOption | null>(selected);
  const [manualOpen, setManualOpen] = useState(false);

  const search = useRecordSearch(source, editing ? text : '', { enabled: open && !disabled });
  const rows: Array<PickerOption | typeof LOAD_MORE> = search.hasMore
    ? [...search.items, LOAD_MORE]
    : search.items;
  const showManual = Boolean(manualEntry) && (manualOpen || search.forbidden);

  // What the input shows when the user is not typing: the chosen record, or the raw id.
  const current = value
    ? chosen?.id === value
      ? chosen
      : selected?.id === value
        ? selected
        : null
    : null;
  const display = editing ? text : current ? current.label : value;

  useEffect(() => {
    if (!open || active < 0) return;
    const element = document.getElementById(`${listId}-${active}`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId]);

  function close() {
    setOpen(false);
    setEditing(false);
    setActive(-1);
  }

  function choose(index: number) {
    const row = rows[index];
    if (row === undefined) return;
    if (row === LOAD_MORE) {
      search.loadMore();
      return;
    }
    if (row.disabledReason) return;
    setChosen(row);
    onChange(row.id, row);
    close();
  }

  function move(delta: 1 | -1) {
    if (!open) {
      setOpen(true);
      return;
    }
    if (rows.length === 0) return;
    setActive((index) => {
      const nextIndex = index < 0 ? (delta === 1 ? 0 : rows.length - 1) : index + delta;
      return Math.max(0, Math.min(rows.length - 1, nextIndex));
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Enter':
        if (open && active >= 0) {
          event.preventDefault();
          choose(active);
        }
        break;
      case 'Escape':
        if (open) {
          // Close the popup only (not a surrounding dialog).
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (editing) {
          setEditing(false);
        }
        break;
      case 'Tab':
        close();
        break;
    }
  }

  const status = !open
    ? ''
    : search.loading
      ? 'Searching…'
      : search.error
        ? search.error
        : search.items.length === 0
          ? noResultsText
          : `${search.items.length} result${search.items.length === 1 ? '' : 's'}${search.hasMore ? ', more available' : ''}.`;

  return (
    <div
      ref={container}
      className={`relative ${className ?? ''}`.trim()}
      onBlur={(event) => {
        if (!container.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <FormField
        id={inputId}
        label={label}
        hint={hint}
        error={error}
        required={required}
        hideLabel={hideLabel}
      >
        {(control) => (
          <div className="flex items-start gap-2">
            <input
              ref={input}
              {...control}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
              autoComplete="off"
              disabled={disabled}
              placeholder={placeholder}
              value={display}
              className={inputClass}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onChange={(event) => {
                setText(event.target.value);
                setEditing(true);
                setOpen(true);
                setActive(-1);
              }}
              onKeyDown={onKeyDown}
            />
            {value && !disabled && (
              <button
                type="button"
                className={`${buttonClass('ghost', 'sm')} mt-1`}
                aria-label={`Clear ${label}`}
                onClick={() => {
                  setChosen(null);
                  setText('');
                  onChange('', null);
                  input.current?.focus();
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </FormField>
      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      <ul
        id={listId}
        role="listbox"
        // Its own name, so the field label keeps pointing at the input alone.
        aria-label="Search results"
        hidden={!open || rows.length === 0}
        className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
      >
        {open &&
          rows.map((row, index) =>
            row === LOAD_MORE ? (
              <li
                key={LOAD_MORE}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={false}
                className={`cursor-pointer px-3 py-2 font-medium text-[var(--hrms-accent-text)] ${active === index ? 'bg-slate-100' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {search.loadingMore ? 'Loading more…' : 'Load more results'}
              </li>
            ) : (
              <li
                key={row.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={row.id === value}
                aria-disabled={row.disabledReason ? true : undefined}
                className={`px-3 py-2 ${row.disabledReason ? 'cursor-not-allowed text-slate-500' : 'cursor-pointer text-slate-900'} ${active === index ? 'bg-slate-100' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className="block font-medium">
                  {row.label}
                  {row.id === value && <span className="sr-only"> (selected)</span>}
                </span>
                {(row.description || row.disabledReason) && (
                  <span className="block text-xs text-slate-600">
                    {[row.description, row.disabledReason].filter(Boolean).join(' · ')}
                  </span>
                )}
              </li>
            ),
          )}
      </ul>
      {open && rows.length === 0 && status && (
        <p
          aria-hidden="true"
          className="absolute z-30 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-lg"
        >
          {status}
        </p>
      )}
      {manualEntry && !showManual && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-[var(--hrms-accent-text)] underline"
          aria-expanded={false}
          onClick={() => setManualOpen(true)}
        >
          Enter an ID instead
        </button>
      )}
      {manualEntry && showManual && (
        <FormField className="mt-2" label={manualEntry.label} hint={manualEntry.hint}>
          {(control) => (
            <input
              {...control}
              className={`${inputClass} font-mono`}
              value={value}
              disabled={disabled}
              onChange={(event) => {
                setChosen(null);
                onChange(event.target.value.trim(), null);
              }}
            />
          )}
        </FormField>
      )}
    </div>
  );
}
