'use client';

import { useEffect, useId, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import { describeValue, fieldOf, POLICY_SECTIONS } from '../../../lib/attendance/policy-schema';
import type {
  AttendanceOrganization,
  EffectivePolicy,
  PolicyChainLayer,
} from '../../../lib/attendance/types';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, label } from '../../../lib/time/format';
import { AssignmentIdPicker } from '../../ui/assignment-id-picker';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';

/** Where a resolved setting comes from, in words. */
export function sourceText(
  view: Pick<EffectivePolicy, 'settings' | 'chain'>,
  section: string,
  key: string,
): { text: string; kind: 'assignment' | 'inherited' | 'default' | 'reset' } {
  const setting = view.settings[section]?.[key];
  const layer = (id: string | undefined): PolicyChainLayer | undefined =>
    view.chain.find((item) => item.id === id);
  if (!setting) return { text: 'Built-in default', kind: 'default' };
  if (setting.source === 'LAYER') {
    const from = layer(setting.layerId);
    if (from?.scopeType === 'EMPLOYMENT_ASSIGNMENT') {
      return { text: 'Set for this assignment', kind: 'assignment' };
    }
    return {
      text: `Inherited from ${from?.scopeName ?? 'a policy'} (${label(from?.scopeType ?? 'POLICY')})`,
      kind: 'inherited',
    };
  }
  if (setting.resetByLayerId) {
    const by = layer(setting.resetByLayerId);
    return {
      text: `Reset to the default by ${by?.scopeName ?? 'a policy'}'s override`,
      kind: 'reset',
    };
  }
  return { text: 'Built-in default', kind: 'default' };
}

const BADGE: Record<string, string> = {
  assignment: 'bg-indigo-50 text-indigo-900 ring-indigo-300',
  inherited: 'bg-slate-100 text-slate-800 ring-slate-300',
  default: 'bg-white text-slate-700 ring-slate-300',
  reset: 'bg-amber-50 text-amber-900 ring-amber-300',
};

export function EffectivePolicyView({ view }: { view: EffectivePolicy }) {
  const tracking =
    view.attendance.trackingMode === 'SIGN_IN_ONLY'
      ? 'Presence only (sign-in, never payable)'
      : 'Timed attendance (clock in and out)';
  return (
    <div className="space-y-5">
      <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-800">
        <p className="font-semibold text-slate-950">
          {view.assignment.position.name} · {view.assignment.organization.name}
        </p>
        <p>
          On {formatDateOnly(view.date)}
          {view.timezone ? ` (${view.timezone})` : ''}: {tracking}; capture:{' '}
          {describeValue(fieldOf('attendance', 'captureMode'), view.attendance.captureMode)}
          {view.attendance.trackingMode === 'SIGN_IN_ONLY' &&
            `; sign-out ${view.attendance.signOutEnabled ? 'allowed' : 'not used'}`}
          .
        </p>
      </div>

      <section aria-labelledby="effective-chain">
        <h3 id="effective-chain" className="text-sm font-semibold text-slate-950">
          Policies applied, broadest first
        </h3>
        {view.chain.length === 0 ? (
          <p className="mt-2 text-sm text-slate-700">
            No policy applies on this date: every setting is the built-in default.
          </p>
        ) : (
          <ol className="mt-2 space-y-1 border-l-2 border-slate-200 pl-4 text-sm">
            {view.chain.map((layer) => (
              <li key={layer.id}>
                <span className="font-medium text-slate-900">{layer.scopeName}</span>{' '}
                <span className="text-slate-600">
                  ({label(layer.scopeType)}) · {formatDateOnly(layer.effectiveFrom)} –{' '}
                  {layer.effectiveTo ? formatDateOnly(layer.effectiveTo) : 'open-ended'}
                </span>{' '}
                {layer.inheritanceMode === 'OVERRIDE' && (
                  <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-300">
                    Overrides broader policies
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {POLICY_SECTIONS.map((section) => (
        <section key={section.key} aria-labelledby={`effective-${section.key}`}>
          <h3 id={`effective-${section.key}`} className="text-sm font-semibold text-slate-950">
            {section.title}
          </h3>
          <div className="mt-2">
            <DataTable
              bare
              label={`${section.title}: effective settings`}
              minWidth="min-w-[560px]"
              rows={section.fields}
              rowKey={(field) => field.key}
              columns={[
                {
                  key: 'setting',
                  header: 'Setting',
                  rowHeader: true,
                  cell: (field) => field.label,
                },
                {
                  key: 'value',
                  header: 'Value',
                  className: 'text-slate-900',
                  cell: (field) => {
                    const value = view.config[section.key]?.[field.key];
                    return value === undefined ? field.defaultText : describeValue(field, value);
                  },
                },
                {
                  key: 'from',
                  header: 'From',
                  cell: (field) => {
                    const source = sourceText(view, section.key, field.key);
                    return (
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${BADGE[source.kind]}`}
                      >
                        {source.text}
                      </span>
                    );
                  },
                },
              ]}
            />
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Batch 4E-2 (B1) — an assignment's effective attendance policy on a date, as the attendance
 * runtime resolves it: every setting with where it comes from (set for the assignment, inherited
 * from a broader policy, the default, or reset to the default by an override).
 */
export function EffectivePolicyPanel({
  organization,
  assignmentId: initialAssignment,
  date: initialDate,
}: {
  organization: AttendanceOrganization;
  assignmentId?: string;
  date?: string;
}) {
  const [assignmentId, setAssignmentId] = useState(initialAssignment ?? '');
  const [date, setDate] = useState(initialDate ?? '');
  const [view, setView] = useState<EffectivePolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateId = useId();

  useEffect(() => {
    if (!assignmentId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      attendanceApi
        .effectivePolicy(assignmentId, date || undefined)
        .then((result) => {
          if (active) setView(result);
        })
        .catch((cause) => {
          if (active) {
            setView(null);
            setError(timeErrorMessage(cause, 'Unable to load the effective policy.'));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assignmentId, date]);

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="text-base font-semibold text-slate-950">Effective policy</h2>
      <p className="text-sm text-slate-600">
        The settings that apply to one employment assignment on a date, and where each comes from.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <AssignmentIdPicker
          label="Employment assignment"
          organizationId={organization.id}
          value={assignmentId}
          onChange={setAssignmentId}
        />
        <div>
          <label htmlFor={dateId} className="block text-sm font-medium text-slate-700">
            On
          </label>
          <input
            id={dateId}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            aria-describedby={`${dateId}-hint`}
            className={inputClass}
          />
          <p id={`${dateId}-hint`} className="mt-1 text-xs text-slate-600">
            Blank is today in the assignment&apos;s time zone.
          </p>
        </div>
      </div>
      {!assignmentId ? (
        <EmptyState title="Choose an assignment to see its effective policy." />
      ) : loading ? (
        <LoadingState label="Resolving the policy…" />
      ) : error ? (
        <ErrorState message={error} />
      ) : view ? (
        <EffectivePolicyView view={view} />
      ) : null}
    </section>
  );
}
