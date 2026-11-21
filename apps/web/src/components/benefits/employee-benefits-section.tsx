'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { benefitsApi } from '../../lib/benefits/api';
import {
  benefitsErrorMessage,
  benefitsFailureKind,
  type BenefitsFailureKind,
} from '../../lib/benefits/errors';
import type { Dependent, Election, EmployeeBenefits } from '../../lib/benefits/types';
import { EmptyState } from '../payroll/payroll-shared';
import { ErrorState } from '../ui/states';
import { primaryButton } from '../ui/tokens';
import { DependentsPanel } from './employee/dependents';
import {
  ChangeDialog,
  CorrectDialog,
  EndDialog,
  EnrollDialog,
  RemoveDependentDialog,
  RescindDialog,
  TransferDialog,
} from './employee/election-dialogs';
import { ElectionHistory, ElectionsTable, type ElectionAction } from './employee/elections';

type Dialog = { kind: 'enroll' } | { kind: ElectionAction; election: Election };
type Failure = { kind: BenefitsFailureKind; message: string };

const failureOf = (cause: unknown, fallback: string): Failure => ({
  kind: benefitsFailureKind(cause),
  message: benefitsErrorMessage(cause, fallback),
});

/**
 * The employee profile's benefits section. Rendered only for benefit.* holders; the API decides
 * what each reader sees (elections sponsored by assignments in scope, dependents and their
 * fields) and may do (action flags). Elections and dependents load independently, each with its
 * own retry; every change happens in a focus-managed dialog keyed by election and action (so
 * nothing carries over from one election to another).
 */
export function EmployeeBenefitsSection({ employeeId }: { employeeId: string }) {
  const [data, setData] = useState<EmployeeBenefits | null>(null);
  const [electionsFailure, setElectionsFailure] = useState<Failure | null>(null);
  const [dependents, setDependents] = useState<Dependent[] | null>(null);
  const [dependentsCanManage, setDependentsCanManage] = useState(false);
  const [dependentsFailure, setDependentsFailure] = useState<Failure | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadElections = useCallback(async () => {
    try {
      setData(await benefitsApi.employee(employeeId));
      setElectionsFailure(null);
    } catch (cause) {
      setData(null);
      setElectionsFailure(failureOf(cause, 'Unable to load the benefit elections.'));
    }
  }, [employeeId]);

  const loadDependents = useCallback(async () => {
    try {
      const result = await benefitsApi.dependents(employeeId, showArchived);
      setDependents(result.items);
      setDependentsCanManage(result.canManage);
      setDependentsFailure(null);
    } catch (cause) {
      setDependents(null);
      setDependentsFailure(failureOf(cause, 'Unable to load the dependents.'));
    }
  }, [employeeId, showArchived]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadElections(), 0);
    return () => window.clearTimeout(timer);
  }, [loadElections]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadDependents(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDependents]);

  const reload = useCallback(
    async (message: string) => {
      setSuccess(message);
      setError(null);
      setDialog(null);
      await Promise.all([loadElections(), loadDependents()]);
    },
    [loadElections, loadDependents],
  );

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await reload(message);
      return true;
    } catch (cause) {
      setError(benefitsErrorMessage(cause, 'Unable to save the benefits change.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const live = (data?.items ?? []).filter((item) => item.status !== 'SUPERSEDED');
  const history = (data?.items ?? []).filter((item) => item.status === 'SUPERSEDED');
  const loadingElections = data === null && electionsFailure === null;
  const refused =
    electionsFailure &&
    (electionsFailure.kind === 'FORBIDDEN' || electionsFailure.kind === 'MODULE_DISABLED');

  const dialogProps =
    dialog && data
      ? {
          data,
          dependents: dependents ?? [],
          onClose: () => setDialog(null),
          onDone: reload,
        }
      : null;

  return (
    <section aria-labelledby="benefits-heading" className="mt-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="benefits-heading" className="text-xl font-semibold text-slate-950">
          Benefits
        </h2>
        {data?.canManage && (
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => {
              setSuccess(null);
              setDialog({ kind: 'enroll' });
            }}
          >
            Record election
          </button>
        )}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      {refused ? (
        <EmptyState>
          {electionsFailure.kind === 'MODULE_DISABLED'
            ? 'Benefits is turned off for this employee’s organization.'
            : 'You do not have access to this employee’s benefits.'}
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="elections-heading" className="space-y-3">
            <h3 id="elections-heading" className="text-lg font-semibold text-slate-900">
              Elections
            </h3>
            {loadingElections ? (
              <p role="status" className="text-sm text-slate-600">
                Loading benefits…
              </p>
            ) : electionsFailure ? (
              <ErrorState
                title="Elections could not be loaded"
                message={electionsFailure.message}
                onRetry={() => {
                  setElectionsFailure(null);
                  void loadElections();
                }}
              />
            ) : (
              <>
                <ElectionsTable
                  items={live}
                  busy={busy}
                  onAction={(kind, election) => {
                    setSuccess(null);
                    setDialog({ kind, election });
                  }}
                />
                <ElectionHistory items={history} />
              </>
            )}
          </section>
          {dependentsFailure ? (
            dependentsFailure.kind === 'FORBIDDEN' ? null : (
              <ErrorState
                title="Dependents could not be loaded"
                message={dependentsFailure.message}
                onRetry={() => {
                  setDependentsFailure(null);
                  void loadDependents();
                }}
              />
            )
          ) : dependents === null ? (
            <p role="status" className="text-sm text-slate-600">
              Loading dependents…
            </p>
          ) : (
            <DependentsPanel
              employeeId={employeeId}
              dependents={dependents}
              canManage={dependentsCanManage}
              showArchived={showArchived}
              onShowArchived={setShowArchived}
              busy={busy}
              run={run}
              onSaved={reload}
            />
          )}
        </>
      )}
      {dialog?.kind === 'enroll' && dialogProps && <EnrollDialog {...dialogProps} />}
      {dialog && dialog.kind !== 'enroll' && dialogProps && (
        <ElectionDialog
          key={`${dialog.kind}:${dialog.election.id}`}
          kind={dialog.kind}
          election={dialog.election}
          {...dialogProps}
        />
      )}
    </section>
  );
}

function ElectionDialog({
  kind,
  ...props
}: { kind: ElectionAction } & Parameters<typeof ChangeDialog>[0]) {
  switch (kind) {
    case 'change':
      return <ChangeDialog {...props} />;
    case 'remove':
      return <RemoveDependentDialog {...props} />;
    case 'transfer':
      return <TransferDialog {...props} />;
    case 'correct':
      return <CorrectDialog {...props} />;
    case 'end':
      return <EndDialog {...props} />;
    case 'rescind':
      return <RescindDialog {...props} />;
  }
}
