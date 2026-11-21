'use client';

import { checkboxClass } from '../ui/tokens';

import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { InlineMessage } from '../ui/inline-message';
import { LoadingText } from '../ui/states';
import { StatusBadge as SharedStatusBadge } from '../ui/status-badge';

export { PageHeader } from '../ui/page-header';

/** Active or archived; the shared status pill (Batch 10A). */
export function StatusBadge({ archived }: { archived: boolean }) {
  return <SharedStatusBadge status={archived ? 'ARCHIVED' : 'ACTIVE'} />;
}

export function ArchivedToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className={checkboxClass}
      />
      Show archived
    </label>
  );
}

/** An error banner (the shared InlineMessage; kept for the ~20 modules importing it). */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return <InlineMessage tone="error">{children}</InlineMessage>;
}

/** A success or error message (the shared InlineMessage; kept for existing imports). */
export function FeedbackMessage({
  children,
  tone = 'success',
}: {
  children: ReactNode;
  tone?: 'success' | 'error';
}) {
  return (
    <InlineMessage tone={tone} as="p">
      {children}
    </InlineMessage>
  );
}

export function RecordActions({
  archived,
  onEdit,
  onArchive,
  onReactivate,
  busy = false,
  readOnly = false,
  editDisabled = false,
}: {
  archived: boolean;
  onEdit(): void;
  onArchive(): Promise<void>;
  onReactivate(): Promise<void>;
  busy?: boolean;
  readOnly?: boolean;
  /** R5B: editing is unavailable for now (the page explains why); archive stays available. */
  editDisabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirmArchive() {
    if (pending) return;
    setPending(true);
    try {
      await onArchive();
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  async function reactivate() {
    if (pending) return;
    setPending(true);
    try {
      await onReactivate();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!archived && !readOnly ? (
        <>
          <button
            type="button"
            disabled={busy || pending || editDisabled}
            onClick={onEdit}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy || pending}
            onClick={() => setConfirming(true)}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-50"
          >
            Archive
          </button>
        </>
      ) : archived && !readOnly ? (
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => void reactivate()}
          className="rounded-md border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
        >
          {pending ? 'Reactivating…' : 'Reactivate'}
        </button>
      ) : null}
      <ConfirmDialog
        open={confirming && !archived}
        title="Archive this record?"
        description="It will be hidden from active lists. You can reactivate it later."
        confirmLabel="Confirm archive"
        busy={pending || busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirmArchive()}
      />
    </div>
  );
}

export function LoadingState() {
  return <LoadingText className="py-8">Loading organization data…</LoadingText>;
}

/** The message of a capped list (`truncated: true` from the API). */
export function truncatedNoticeText(shown: number) {
  return `Showing the first ${shown.toLocaleString('en-US')} results — narrow the filters to see more.`;
}

/**
 * Shown when the API capped a list for safety (`truncated: true`); renders nothing otherwise.
 * `shown` is the number of rows actually returned.
 */
export function TruncatedNotice({ truncated, shown }: { truncated?: boolean; shown: number }) {
  if (!truncated) return null;
  return (
    <p
      role="note"
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {truncatedNoticeText(shown)}
    </p>
  );
}
