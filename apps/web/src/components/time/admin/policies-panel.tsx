'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import { describeValue, fieldOf, POLICY_SECTIONS } from '../../../lib/attendance/policy-schema';
import type { AttendanceOrganization, TimePolicy } from '../../../lib/attendance/types';
import { todayIn } from '../../../lib/scheduling/time';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, label } from '../../../lib/time/format';
import { buttonClass } from '../../ui/button';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { useConfirm } from '../../ui/use-confirm';
import { PolicyEditor } from './policy-editor';

export type Show = 'current' | 'ended' | 'archived';

/** The settings a layer sets, in words ("Breaks: Automatic unpaid deduction"). */
function settingsOf(policy: TimePolicy): string[] {
  const lines: string[] = [];
  for (const section of POLICY_SECTIONS) {
    const values = policy.config[section.key];
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      const field = fieldOf(section.key, key);
      if (!field) continue;
      lines.push(`${field.label}: ${describeValue(field, value)}`);
    }
  }
  return lines;
}

/**
 * Whether a layer belongs under a filter on `today`, the organization's local date (as the API
 * dates attendance): a layer ending today is still current; it is ended from the next day.
 */
export function inShow(policy: TimePolicy, show: Show, today: string) {
  if (show === 'archived') return policy.archivedAt !== null;
  if (policy.archivedAt) return false;
  const ended = policy.effectiveTo !== null && policy.effectiveTo < today;
  return show === 'ended' ? ended : !ended;
}

/**
 * Batch 4E-2 — the organization's policy layers (and the system layers, read-only) by scope
 * name: current and scheduled, ended, or archived. Layers are effective-dated and never edited:
 * a change replaces a layer from a date (atomically), ends it, or archives one not yet started.
 */
export function PoliciesPanel({
  organization,
  onInspect,
}: {
  organization: AttendanceOrganization;
  onInspect?(): void;
}) {
  const [show, setShow] = useState<Show>('current');
  const [policies, setPolicies] = useState<TimePolicy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [ending, setEnding] = useState<TimePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [confirm, confirmDialog] = useConfirm();
  const showName = useId();
  // The organization's own date, not the viewer's or UTC: near midnight they differ.
  const today = todayIn(organization.timezone);

  const load = useCallback(async () => {
    try {
      const result = await attendanceApi.policies(organization.id, show === 'archived');
      setPolicies(result.items);
      setLoadError(null);
    } catch (cause) {
      setPolicies([]);
      setLoadError(timeErrorMessage(cause, 'Unable to load attendance policies.'));
    }
  }, [organization.id, show]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function saved(message: string) {
    setSuccess(message);
    setError(null);
    setReplacing(null);
    setEditorKey((key) => key + 1);
    void load();
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
      await load();
      return true;
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to change this policy.'));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  function end(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ending) return;
    const effectiveTo = String(new FormData(event.currentTarget).get('effectiveTo') ?? '');
    void run(() => attendanceApi.endPolicy(ending.id, effectiveTo), 'Policy end date set.').then(
      (done) => {
        if (done) setEnding(null);
      },
    );
  }

  const visible = (policies ?? []).filter((policy) => inShow(policy, show, today));

  return (
    <div className="space-y-5">
      {confirmDialog}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-base font-semibold text-slate-950">Attendance policies</h2>
        <p className="text-sm text-slate-600">
          Policy layers are effective-dated and never edited: to change one, replace it from a date;
          its earlier days stay as they were. Settings a layer leaves blank are inherited from
          broader scopes (system, organization, unit, department, team, assignment).
        </p>
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Show</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {(
              [
                ['current', 'Current and scheduled'],
                ['ended', 'Ended'],
                ['archived', 'Archived'],
              ] as const
            ).map(([value, text]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium focus-within:outline-hidden focus-within:ring-2 focus-within:ring-[var(--hrms-accent-text)] ${
                  show === value
                    ? 'border-indigo-700 bg-indigo-50 text-indigo-900'
                    : 'border-slate-300 bg-white text-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name={showName}
                  value={value}
                  checked={show === value}
                  onChange={() => setShow(value)}
                  className="sr-only"
                />
                {text}
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
            {error}
          </p>
        )}
        {success && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          >
            <span>{success}</span>
            {onInspect && (
              <button type="button" onClick={onInspect} className={buttonClass('secondary', 'sm')}>
                Inspect the effective policy
              </button>
            )}
          </div>
        )}
        {policies === null ? (
          <LoadingState label="Loading policies…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : visible.length === 0 ? (
          <EmptyState title="No policies to show." />
        ) : (
          <ul className="space-y-3">
            {visible.map((policy) => {
              const system = policy.scopeType === 'SYSTEM';
              const settings = settingsOf(policy);
              return (
                <li key={policy.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-950">
                        {policy.scopeName ?? label(policy.scopeType)}
                        <span className="ml-2 text-sm font-normal text-slate-600">
                          {label(policy.scopeType)}
                        </span>
                      </p>
                      <p className="text-sm text-slate-700">
                        {formatDateOnly(policy.effectiveFrom)} –{' '}
                        {policy.effectiveTo ? formatDateOnly(policy.effectiveTo) : 'open-ended'}{' '}
                        {policy.inheritanceMode === 'OVERRIDE' && (
                          <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-300">
                            Overrides broader policies
                          </span>
                        )}{' '}
                        {system && (
                          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">
                            System policy · read-only
                          </span>
                        )}
                      </p>
                    </div>
                    {!system && !policy.archivedAt && (
                      <div className="flex flex-wrap gap-2">
                        {policy.actions?.canEnd && (
                          <>
                            <button
                              type="button"
                              aria-expanded={replacing === policy.id}
                              onClick={() =>
                                setReplacing(replacing === policy.id ? null : policy.id)
                              }
                              className={buttonClass('secondary', 'sm')}
                            >
                              Change from a date{' '}
                              <span className="sr-only">
                                for {policy.scopeName ?? label(policy.scopeType)}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setEnding(policy)}
                              className={buttonClass('secondary', 'sm')}
                            >
                              End{' '}
                              <span className="sr-only">
                                {policy.scopeName ?? label(policy.scopeType)} policy
                              </span>
                            </button>
                          </>
                        )}
                        {policy.actions?.canArchive && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: 'Archive this policy?',
                                  description:
                                    'It has not taken effect yet, so nothing was recorded under it. It stays in the audit history.',
                                  confirmLabel: 'Archive policy',
                                })
                              ) {
                                void run(
                                  () => attendanceApi.archivePolicy(policy.id),
                                  'Policy archived.',
                                );
                              }
                            }}
                            className={buttonClass('danger', 'sm')}
                          >
                            Archive{' '}
                            <span className="sr-only">
                              {policy.scopeName ?? label(policy.scopeType)} policy
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {settings.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-600">
                      Sets nothing itself (inherits everything).
                    </p>
                  ) : (
                    <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-800 md:grid-cols-2">
                      {settings.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {replacing === policy.id && (
                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                      <PolicyEditor
                        organization={organization}
                        mode={{ kind: 'supersede', policy }}
                        onSaved={saved}
                        onCancel={() => setReplacing(null)}
                        onInspect={onInspect}
                        onStale={() => {
                          setReplacing(null);
                          void load();
                        }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {ending && (
          <form
            onSubmit={end}
            aria-label="End policy"
            className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
          >
            <p className="w-full text-sm text-slate-700">
              End the {ending.scopeName ?? label(ending.scopeType)} policy. Its settings stop
              applying after the day you choose; broader policies apply from then on.
            </p>
            <label className="text-sm font-medium text-slate-700">
              Last effective day
              <input name="effectiveTo" type="date" required className={inputClass} />
            </label>
            <button type="submit" disabled={busy} className={buttonClass('primary')}>
              End policy
            </button>
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => setEnding(null)}
            >
              Cancel
            </button>
          </form>
        )}
      </section>
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-base font-semibold text-slate-950">Add an attendance policy</h2>
        <PolicyEditor
          key={editorKey}
          organization={organization}
          mode={{ kind: 'create' }}
          onSaved={saved}
          onInspect={onInspect}
        />
      </section>
    </div>
  );
}
