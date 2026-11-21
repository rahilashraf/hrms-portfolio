'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { compensationApi } from '../../lib/compensation/api';
import { compensationErrorMessage, isCompensationForbidden } from '../../lib/compensation/errors';
import type {
  CompensationAssignmentView,
  CompensationTimelineRecord,
  EmployeeCompensation,
} from '../../lib/compensation/types';
import { AssignmentStatusBadge } from '../employee/employee-shared';
import {
  CompensationChangeForm,
  CompensationCorrectForm,
  CompensationCreateForm,
  CompensationEndForm,
} from './compensation-forms';
import {
  assignmentTitle,
  CompensationHistory,
  CompensationOnDate,
  CurrentCompensation,
  EmptyState,
  secondaryButton,
} from './compensation-shared';

type Action =
  | { kind: 'create' }
  | { kind: 'change' }
  | { kind: 'correct'; record: CompensationTimelineRecord }
  | { kind: 'end'; record: CompensationTimelineRecord };

/**
 * The employee profile's compensation section. Rendered only for users holding a compensation
 * permission; the API decides per assignment what they may see and do (the `actions` flags).
 */
export function EmployeeCompensationSection({ employeeId }: { employeeId: string }) {
  const [data, setData] = useState<EmployeeCompensation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await compensationApi.employee(employeeId));
      setError(null);
      setForbidden(false);
    } catch (cause) {
      setForbidden(isCompensationForbidden(cause));
      setError(compensationErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section aria-labelledby="compensation-heading" className="mt-8 space-y-4">
      <h2 id="compensation-heading" className="text-xl font-semibold text-slate-950">
        Compensation
      </h2>
      {loading ? (
        <p role="status" className="text-sm text-slate-600">
          Loading compensation…
        </p>
      ) : forbidden ? (
        <EmptyState>You do not have access to this employee’s compensation.</EmptyState>
      ) : error ? (
        <ErrorBanner>{error}</ErrorBanner>
      ) : !data || data.assignments.length === 0 ? (
        <EmptyState>No assignments with compensation to show.</EmptyState>
      ) : (
        data.assignments.map((view) => (
          <AssignmentCompensation key={view.assignment.id} view={view} onSaved={load} />
        ))
      )}
    </section>
  );
}

function AssignmentCompensation({
  view,
  onSaved,
}: {
  view: CompensationAssignmentView;
  onSaved(): Promise<void>;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const assignmentId = view.assignment.id;
  const organizationId = view.assignment.organization.id;

  function open(next: Action) {
    setAction(next);
    setError(null);
    setSuccess(null);
  }

  async function mutate(run: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setAction(null);
      setSuccess(message);
      await onSaved();
    } catch (cause) {
      setError(compensationErrorMessage(cause, 'Unable to save compensation.'));
    } finally {
      setBusy(false);
    }
  }

  const latest = view.current ?? view.timeline[view.timeline.length - 1] ?? null;

  return (
    <article
      aria-label={`Compensation for ${assignmentTitle(view)}`}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{assignmentTitle(view)}</h3>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-600">
            <AssignmentStatusBadge status={view.assignment.status} />
            {view.assignment.isPrimary && <span>Primary</span>}
          </p>
        </div>
        <div className="flex gap-2">
          {view.actions.canCreate && (
            <button
              type="button"
              disabled={busy}
              onClick={() => open({ kind: 'create' })}
              className={secondaryButton}
            >
              Add compensation
            </button>
          )}
          {view.actions.canChange && (
            <button
              type="button"
              disabled={busy}
              onClick={() => open({ kind: 'change' })}
              className={secondaryButton}
            >
              Change compensation
            </button>
          )}
        </div>
      </div>
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <CurrentCompensation view={view} />
      <CompensationOnDate key={`${view.assignment.id}-${view.asOf ?? ''}`} view={view} />
      {action?.kind === 'create' && (
        <CompensationCreateForm
          organizationId={organizationId}
          defaultStart={view.assignment.startDate}
          busy={busy}
          error={error}
          onCancel={() => setAction(null)}
          onSubmit={(input) =>
            void mutate(() => compensationApi.create(assignmentId, input), 'Compensation added.')
          }
        />
      )}
      {action?.kind === 'change' && (
        <CompensationChangeForm
          organizationId={organizationId}
          basis={latest}
          busy={busy}
          error={error}
          onCancel={() => setAction(null)}
          onSubmit={(input) =>
            void mutate(() => compensationApi.change(assignmentId, input), 'Compensation changed.')
          }
        />
      )}
      {action?.kind === 'correct' && (
        <CompensationCorrectForm
          key={action.record.id}
          organizationId={organizationId}
          record={action.record}
          busy={busy}
          error={error}
          onCancel={() => setAction(null)}
          onSubmit={(input) =>
            void mutate(
              () => compensationApi.correct(assignmentId, action.record.id, input),
              'Compensation corrected.',
            )
          }
        />
      )}
      {action?.kind === 'end' && (
        <CompensationEndForm
          key={action.record.id}
          record={action.record}
          busy={busy}
          error={error}
          onCancel={() => setAction(null)}
          onSubmit={(input) =>
            void mutate(
              () => compensationApi.end(assignmentId, action.record.id, input),
              'Compensation period ended.',
            )
          }
        />
      )}
      <h4 className="text-sm font-semibold uppercase text-slate-500">History</h4>
      <CompensationHistory
        view={view}
        busy={busy}
        onCorrect={(record) => open({ kind: 'correct', record })}
        onEnd={(record) => open({ kind: 'end', record })}
      />
    </article>
  );
}
