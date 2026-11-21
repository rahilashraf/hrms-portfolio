'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthApiError } from '../../lib/auth/types';
import {
  readSetupHidden,
  readSetupSkipped,
  setupApi,
  writeSetupHidden,
  writeSetupSkipped,
  type SetupChecklist as Checklist,
} from '../../lib/setup/api';
import { Icon } from '../shell/icons';
import { buttonClass } from '../ui/button';
import { ErrorState, Skeleton } from '../ui/states';

/** Who may see the checklist (the API answers 403 otherwise). Never by role name. */
export const SETUP_PERMISSIONS = ['organization.read', 'organization.manage'] as const;

export function canSeeSetup(permissions: ReadonlySet<string> | null | undefined): boolean {
  return Boolean(permissions && SETUP_PERMISSIONS.some((key) => permissions.has(key)));
}

/**
 * Phase 20 — the organization setup checklist (GET /organizations/:id/setup). Each step's
 * complete/incomplete state comes from the API only (derived from real data); optional steps
 * are marked. "Skip" and "Hide for now" are per-user, per-organization browser preferences
 * that guide and never block.
 */
export function SetupChecklist(props: {
  organizationId: string;
  userId: string;
  /** `card`: dashboard card (hideable); `full`: the Company Settings section. */
  variant?: 'card' | 'full';
}) {
  return <SetupChecklistInner key={`${props.userId}:${props.organizationId}`} {...props} />;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; checklist: Checklist }
  | { status: 'hidden-by-api' }
  | { status: 'error' };

function SetupChecklistInner({
  organizationId,
  userId,
  variant = 'card',
}: {
  organizationId: string;
  userId: string;
  variant?: 'card' | 'full';
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [hidden, setHidden] = useState(() =>
    variant === 'card' ? readSetupHidden(userId, organizationId) : false,
  );
  const [skipped, setSkipped] = useState<string[]>(() => readSetupSkipped(userId, organizationId));

  useEffect(() => {
    if (hidden) return;
    let active = true;
    setupApi
      .get(organizationId)
      .then((checklist) => {
        if (active) setState({ status: 'ready', checklist });
      })
      .catch((cause) => {
        if (!active) return;
        // Not allowed / not visible: the checklist simply is not shown.
        if (cause instanceof AuthApiError && (cause.status === 403 || cause.status === 404)) {
          setState({ status: 'hidden-by-api' });
        } else {
          setState({ status: 'error' });
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId, hidden, attempt]);

  function setHiddenPreference(next: boolean) {
    writeSetupHidden(userId, organizationId, next);
    setHidden(next);
  }

  function toggleSkip(key: string) {
    const next = skipped.includes(key) ? skipped.filter((item) => item !== key) : [...skipped, key];
    writeSetupSkipped(userId, organizationId, next);
    setSkipped(next);
  }

  if (hidden) {
    return (
      <section
        aria-label="Setup checklist (hidden)"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600"
      >
        <span>The setup checklist is hidden for now.</span>
        <button
          type="button"
          onClick={() => setHiddenPreference(false)}
          className={buttonClass('secondary', 'sm')}
        >
          Show setup checklist
        </button>
      </section>
    );
  }
  if (state.status === 'hidden-by-api') return null;

  const headingId = `setup-heading-${variant}`;
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-semibold text-slate-950">
            Set up your organization
          </h2>
          {state.status === 'ready' && <Progress checklist={state.checklist} />}
        </div>
        {variant === 'card' && (
          <button
            type="button"
            onClick={() => setHiddenPreference(true)}
            className={buttonClass('ghost', 'sm')}
          >
            Hide for now
          </button>
        )}
      </div>
      {state.status === 'loading' ? (
        <div className="mt-4 space-y-3">
          <p role="status" className="sr-only">
            Loading setup checklist…
          </p>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div className="mt-4">
          <ErrorState
            title="Setup checklist unavailable"
            message="The setup checklist could not be loaded."
            onRetry={() => {
              setState({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          />
        </div>
      ) : state.checklist.steps.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">
          There are no setup steps for this organization.
        </p>
      ) : (
        <ol className="mt-4 divide-y divide-slate-100">
          {state.checklist.steps.map((step) => {
            const isSkipped = !step.complete && step.optional && skipped.includes(step.key);
            return (
              <li
                key={step.key}
                data-step={step.key}
                data-complete={step.complete ? 'true' : 'false'}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 gap-3">
                  <span
                    className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border ${
                      step.complete
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'border-slate-300 bg-white text-slate-500'
                    }`}
                    aria-hidden="true"
                  >
                    {step.complete && <Icon name="check" className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">
                      {step.label}
                      <span className="sr-only">
                        {step.complete
                          ? ' (complete)'
                          : isSkipped
                            ? ' (skipped)'
                            : ' (not complete)'}
                      </span>
                      {step.optional && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          Optional
                        </span>
                      )}
                      {isSkipped && (
                        <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                          Skipped
                        </span>
                      )}
                    </p>
                    {step.description && (
                      <p className="mt-0.5 text-sm text-slate-600">{step.description}</p>
                    )}
                    {step.detail && <p className="mt-0.5 text-xs text-slate-500">{step.detail}</p>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 pl-9 sm:pl-0">
                  {!step.complete && (
                    <Link href={step.href} className={buttonClass('secondary', 'sm')}>
                      {isSkipped ? 'Set up' : 'Fix'}
                      <span className="sr-only">: {step.label}</span>
                    </Link>
                  )}
                  {!step.complete && step.optional && (
                    <button
                      type="button"
                      onClick={() => toggleSkip(step.key)}
                      className={buttonClass('ghost', 'sm')}
                    >
                      {isSkipped ? 'Undo skip' : 'Skip for now'}
                      <span className="sr-only">: {step.label}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Progress({ checklist }: { checklist: Checklist }) {
  const required = checklist.steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.complete).length;
  return (
    <p className="mt-1 text-sm text-slate-600">
      {required.length === 0
        ? 'Only optional steps remain.'
        : done === required.length
          ? 'All required steps are complete.'
          : `${done} of ${required.length} required steps complete.`}
    </p>
  );
}
