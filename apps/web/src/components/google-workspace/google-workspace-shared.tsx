'use client';

import { useEffect, useState } from 'react';
import { googleCodeText, googleWorkspaceErrorMessage } from '../../lib/google-workspace/errors';
import type { GoogleConnectionStatus, GoogleSyncRunStatus } from '../../lib/google-workspace/types';
import { dangerButton } from '../ui/tokens';

export {
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  primaryButton,
  secondaryButton,
  Section,
} from '../documents/documents-shared';
import { LoadingText } from '../ui/states';

/**
 * Runs a change: clears banners, reports success (a fixed text or one built from the result)
 * and reloads the page data. Resolves to whether it succeeded.
 */
export type Mutate = <T>(
  action: () => Promise<T>,
  message: string | ((result: T) => string),
) => Promise<boolean>;

/** Batch 10F: the shared 24 px checkbox. */
export { checkboxClass as checkbox } from '../ui/tokens';
export { dangerButton };
const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';

const CONNECTION_STYLES: Record<GoogleConnectionStatus, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-800',
  ERROR: 'bg-rose-50 text-rose-800',
  CREDENTIALS_UNAVAILABLE: 'bg-amber-50 text-amber-800',
  DISCONNECTED: 'bg-slate-200 text-slate-700',
};

export const CONNECTION_STATUS_LABELS: Record<GoogleConnectionStatus, string> = {
  ACTIVE: 'Connected',
  ERROR: 'Needs attention',
  CREDENTIALS_UNAVAILABLE: 'Credentials unavailable',
  DISCONNECTED: 'Disconnected',
};

export function ConnectionStatusBadge({ status }: { status: GoogleConnectionStatus | null }) {
  if (!status) return <span className={`${badge} bg-slate-100 text-slate-700`}>Not connected</span>;
  return (
    <span className={`${badge} ${CONNECTION_STYLES[status]}`}>
      {CONNECTION_STATUS_LABELS[status]}
    </span>
  );
}

const RUN_STYLES: Record<GoogleSyncRunStatus, string> = {
  RUNNING: 'bg-sky-50 text-sky-800',
  SUCCEEDED: 'bg-emerald-50 text-emerald-800',
  PARTIAL: 'bg-amber-50 text-amber-800',
  FAILED: 'bg-rose-50 text-rose-800',
};

export const RUN_STATUS_LABELS: Record<GoogleSyncRunStatus, string> = {
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  PARTIAL: 'Partial',
  FAILED: 'Failed',
};

export function RunStatusBadge({ status }: { status: GoogleSyncRunStatus }) {
  return <span className={`${badge} ${RUN_STYLES[status]}`}>{RUN_STATUS_LABELS[status]}</span>;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className={`${badge} bg-emerald-50 text-emerald-800`}>Enabled</span>
  ) : (
    <span className={`${badge} bg-slate-200 text-slate-700`}>Disabled</span>
  );
}

/** A recorded error code: friendly text, with the code itself as plain text for support. */
export function ErrorCodeText({ code }: { code: string | null | undefined }) {
  const text = googleCodeText(code);
  if (!text) return <span>—</span>;
  return (
    <span>
      {text} <code className="rounded bg-slate-100 px-1 text-xs text-slate-700">{code}</code>
    </span>
  );
}

export { LoadingText as Loading };

/** Loads data whenever `load` changes; errors go to `onError`. */
export function useData<T>(load: () => Promise<T>, onError: (message: string) => void) {
  const [state, setState] = useState<{ data: T | null; loaded: boolean }>({
    data: null,
    loaded: false,
  });
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load()
        .then((data) => {
          if (active) setState({ data, loaded: true });
        })
        .catch((cause) => {
          if (!active) return;
          onError(googleWorkspaceErrorMessage(cause));
          setState({ data: null, loaded: true });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, onError]);
  return state;
}
