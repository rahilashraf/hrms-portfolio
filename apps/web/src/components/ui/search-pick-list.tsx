'use client';

import { useId, useState, type ReactNode } from 'react';
import { useRecordSearch, type RecordSource } from '../../lib/pickers/use-record-search';
import { InlineMessage } from './inline-message';
import { buttonClass } from './button';
import { EmptyState, LoadingText } from './states';
import { inputClass } from './tokens';

/**
 * Batch 3B — a search box over a visible, paged list of records to pick from (for pickers that
 * stay open, e.g. choosing a position while creating an assignment). Uses the shared record
 * search: debounced, cursor pages, stale answers ignored. The chosen row is `aria-pressed`;
 * rows that cannot be chosen are disabled and say why.
 */
export function SearchPickList<T>({
  searchLabel,
  placeholder,
  source,
  getKey,
  isSelected,
  renderItem,
  unavailableReason,
  emptyText,
  loadMoreLabel,
  describeError,
  onSelect,
}: {
  searchLabel: string;
  placeholder?: string;
  source: RecordSource<T>;
  getKey(item: T): string;
  isSelected(item: T): boolean;
  renderItem(item: T): ReactNode;
  /** Set for rows that cannot be chosen; shown on the row. */
  unavailableReason?(item: T): string | null;
  emptyText: string;
  loadMoreLabel: string;
  describeError?: (cause: unknown) => string;
  onSelect(item: T): void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const search = useRecordSearch(source, query, { debounceMs: 300, describeError });
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={searchId} className="block text-sm font-medium text-slate-700">
          {searchLabel}
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
      </div>
      {search.error && <InlineMessage tone="error">{search.error}</InlineMessage>}
      {search.loading ? (
        <LoadingText />
      ) : search.items.length === 0 ? (
        !search.error && <EmptyState>{emptyText}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
          {search.items.map((item) => {
            const selected = isSelected(item);
            const reason = unavailableReason?.(item) ?? null;
            return (
              <li key={getKey(item)}>
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={reason !== null}
                  onClick={() => onSelect(item)}
                  className={`flex w-full items-start justify-between gap-4 px-4 py-3 text-left text-sm disabled:cursor-not-allowed disabled:bg-slate-50 ${selected ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                >
                  <span>{renderItem(item)}</span>
                  {reason ? (
                    <span className="text-xs font-medium text-slate-600">{reason}</span>
                  ) : selected ? (
                    <span className="text-xs font-medium text-[var(--hrms-accent-text)]">
                      Selected
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!search.loading && search.hasMore && (
        <button
          type="button"
          disabled={search.loadingMore}
          onClick={search.loadMore}
          className={buttonClass('secondary', 'sm')}
        >
          {search.loadingMore ? 'Loading…' : loadMoreLabel}
        </button>
      )}
    </div>
  );
}
