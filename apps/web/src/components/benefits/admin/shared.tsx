'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { benefitsErrorMessage, benefitsFailureKind } from '../../../lib/benefits/errors';
import type { BenefitType, CoverageLevel, RateFrequency } from '../../../lib/benefits/types';
import { secondaryButton } from '../benefits-shared';

/**
 * Batch 7C — Benefits administration building blocks (the Benefits counterpart of the 7B
 * performance admin shared module).
 */

/**
 * Runs a change, reports its message and reloads the sections. An error goes to the page
 * banner, or to `onError` (a dialog shows it next to its fields instead).
 */
export type Mutate = (
  action: () => Promise<unknown>,
  message: string,
  options?: { onError?(message: string): void },
) => Promise<boolean>;

/** The admin page's context for every section. */
export interface SectionProps {
  organizationId: string;
  canManagePlans: boolean;
  busy: boolean;
  mutate: Mutate;
  /** Bumped after every successful change (sections reload). */
  version: number;
}

export const BENEFIT_TYPES: BenefitType[] = [
  'HEALTH',
  'DENTAL',
  'VISION',
  'LIFE',
  'DISABILITY',
  'RETIREMENT',
  'WELLNESS',
  'OTHER',
];
export const COVERAGE_LEVELS: CoverageLevel[] = [
  'EMPLOYEE_ONLY',
  'EMPLOYEE_SPOUSE',
  'EMPLOYEE_CHILDREN',
  'FAMILY',
  'CUSTOM',
];
export const FREQUENCIES: RateFrequency[] = ['MONTHLY', 'PER_PAY_PERIOD', 'ANNUAL'];
export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT'] as const;

/** Money as the API takes it: a non-negative decimal with at most two places. */
export const AMOUNT_PATTERN = '\\d+(\\.\\d{1,2})?';
export const isAmount = (value: string) => /^\d+(\.\d{1,2})?$/.test(value.trim());

// Batch 10E-2: the shared label/hint wiring (was a local copy here and in two other modules).
export { ControlField as Field } from '../../ui/form/form-field';

/**
 * Why a benefits read failed, in words: Benefits switched off, a missing permission, or the
 * API's own message — never a false empty state.
 */
export function loadErrorMessage(cause: unknown) {
  switch (benefitsFailureKind(cause)) {
    case 'MODULE_DISABLED':
      return 'Benefits is turned off for this organization.';
    case 'FORBIDDEN':
      return benefitsErrorMessage(cause, 'You do not have permission to view this.');
    default:
      return benefitsErrorMessage(cause);
  }
}

/** An error message for an admin action (domain codes explained). */
export function adminErrorMessage(cause: unknown, fallback?: string) {
  return benefitsErrorMessage(cause, fallback ?? 'Unable to complete the benefits action.');
}

/**
 * One section's data, loaded on its own (a failing section never blanks the others). Reloads
 * when `deps` change; an answer to an older request (e.g. the previous organization) is
 * ignored; `reload` retries.
 */
export function useSectionData<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const key = JSON.stringify(deps);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    loader
      .current()
      .then((value) => {
        if (current === generation.current) setData(value);
      })
      .catch((cause) => {
        if (current === generation.current) setError(loadErrorMessage(cause));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    // `key` stands for `deps` (reload when they change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const timer = window.setTimeout(reload, 0);
    return () => {
      window.clearTimeout(timer);
      // A pending answer for these deps is stale once they change.
      generation.current += 1;
    };
  }, [reload]);
  return { data, error, loading, reload };
}

/** Loading, error (with retry) or the content of a section. */
export function SectionState({
  loading,
  error,
  onRetry,
  what,
  hasData,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry(): void;
  what: string;
  /** Keep showing loaded content while it reloads. */
  hasData?: boolean;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
        <p className="text-rose-900">
          Unable to load {what}: {error}
        </p>
        <button type="button" className={`${secondaryButton} mt-2`} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (loading && !hasData) {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading {what}…
      </p>
    );
  }
  return <>{children}</>;
}
