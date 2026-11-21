'use client';

import { checkboxClass } from '../ui/tokens';

import { ConfirmDialog } from '../ui/confirm-dialog';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import { formatLeaveAmount, formatLeaveRange, label } from '../../lib/leave/format';
import type {
  LeaveLedgerView,
  LeavePreview,
  LeaveRequestDetail,
  LeaveRequestInput,
  MyLeaveOverview,
  MyLeaveRequest,
} from '../../lib/leave/types';
import {
  BalanceFigures,
  dangerButton,
  EmptyState,
  inputClass,
  LeaveDaysTable,
  LeaveStatusPill,
  LedgerTable,
  Panel,
  primaryButton,
  LeaveRequestProgress,
  RequestHistory,
  secondaryButton,
} from './leave-shared';
import { TeamCalendarAndHolidays } from './leave-team-calendar';
import { DataTable } from '../ui/data-table';
import { PageContainer } from '../ui/page-container';

export function EmployeeLeavePage() {
  const [overview, setOverview] = useState<MyLeaveOverview | null>(null);
  const [requests, setRequests] = useState<MyLeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [detail, setDetail] = useState<LeaveRequestDetail | null>(null);
  const [cancelling, setCancelling] = useState<MyLeaveRequest | null>(null);
  const [ledger, setLedger] = useState<LeaveLedgerView | null>(null);

  const load = useCallback(async () => {
    const [nextOverview, nextRequests] = await Promise.all([
      leaveApi.me(),
      leaveApi.myRequests({ limit: 50 }),
    ]);
    setOverview(nextOverview);
    setRequests(nextRequests.items);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      load()
        .catch((cause) => {
          if (active) setError(leaveErrorMessage(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  async function mutate(key: string, action: () => Promise<unknown>, message: string) {
    if (busy) return false;
    setBusy(key);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(leaveErrorMessage(cause, 'Unable to complete this leave action.'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function show(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(leaveErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <PageContainer width="wide">
        <p role="status" className="text-sm text-slate-600">
          Loading leave…
        </p>
      </PageContainer>
    );
  }

  const balances = (overview?.assignments ?? []).flatMap((assignment) =>
    assignment.leaveTypes.filter((row) => row.balance).map((row) => ({ assignment, row })),
  );

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Self service"
        title="Leave"
        description="Balances, requests and history. Amounts are sized by the backend from your published schedule or standard workday."
      />
      <div className="mt-6 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
      </div>

      <section className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        {balances.length === 0 ? (
          <div className="md:col-span-2">
            <EmptyState>No tracked leave balances.</EmptyState>
          </div>
        ) : (
          balances.map(({ assignment, row }) => (
            <article
              key={`${assignment.employmentAssignmentId}-${row.leaveType.id}`}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-950">{row.leaveType.name}</h2>
                  <p className="text-sm text-slate-600">
                    {assignment.position.name} · {assignment.organization.name}
                    {assignment.asOf && ` · as of ${assignment.asOf}`}
                  </p>
                </div>
                {row.accountId && (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy === `ledger-${row.accountId}`}
                    onClick={() =>
                      void show(`ledger-${row.accountId}`, async () =>
                        setLedger(await leaveApi.myLedger(row.accountId!)),
                      )
                    }
                  >
                    History
                  </button>
                )}
              </div>
              <div className="mt-4">
                <BalanceFigures balance={row.balance!} unit={row.leaveType.displayUnit} />
              </div>
            </article>
          ))
        )}
      </section>

      {ledger && (
        <div className="mt-8">
          <Panel
            title={`${ledger.account.leaveType.name} history`}
            actions={
              <button type="button" className={secondaryButton} onClick={() => setLedger(null)}>
                Close
              </button>
            }
          >
            <LedgerTable ledger={ledger} />
          </Panel>
        </div>
      )}

      <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Request leave">
          {overview && (
            <RequestLeaveForm
              overview={overview}
              busy={busy}
              onPreview={(input) => leaveApi.previewOwn(input)}
              onSubmit={(input) =>
                mutate('submit', () => leaveApi.submitOwn(input), 'Leave requested.')
              }
              onError={(cause) =>
                setError(leaveErrorMessage(cause, 'Unable to preview this leave.'))
              }
            />
          )}
        </Panel>
        <Panel title="My requests">
          <MyRequestsTable
            requests={requests}
            busy={busy}
            onDetails={(id) =>
              void show(`detail-${id}`, async () => setDetail(await leaveApi.myRequest(id)))
            }
            onCancel={setCancelling}
          />
          <ConfirmDialog
            open={cancelling !== null}
            title={
              cancelling?.status === 'PENDING'
                ? 'Withdraw this leave request?'
                : 'Cancel this leave?'
            }
            description={
              cancelling?.status === 'PENDING'
                ? 'The request is withdrawn before anyone decides on it. You can submit a new one later.'
                : 'The remaining future days are cancelled and returned to your balance. Days already taken stay as taken.'
            }
            confirmLabel={cancelling?.status === 'PENDING' ? 'Withdraw request' : 'Cancel leave'}
            cancelLabel="Keep leave"
            busy={busy !== null}
            onCancel={() => setCancelling(null)}
            onConfirm={() => {
              const request = cancelling;
              if (!request) return;
              setCancelling(null);
              void mutate(
                `cancel-${request.id}`,
                () => leaveApi.cancelOwn(request.id),
                'Leave cancelled.',
              ).then((ok) => {
                if (ok && detail?.id === request.id) setDetail(null);
              });
            }}
          />
        </Panel>
      </section>

      <section className="mt-8">
        <TeamCalendarAndHolidays />
      </section>

      {detail && (
        <div className="mt-8">
          <Panel
            title={`${detail.leaveType.name} · ${formatLeaveRange(detail.startDate, detail.endDate, detail.startLocalTime, detail.endLocalTime)}`}
            actions={
              <button type="button" className={secondaryButton} onClick={() => setDetail(null)}>
                Close
              </button>
            }
          >
            <div className="mb-4">
              <LeaveRequestProgress detail={detail} />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
              <LeaveStatusPill value={detail.status} />
              <span>Requested {formatLeaveAmount(detail.requestedMinutes)}</span>
              {detail.approvedMinutes !== null && (
                <span>Approved {formatLeaveAmount(detail.approvedMinutes)}</span>
              )}
              {detail.decisionNote && <span>Note: {detail.decisionNote}</span>}
            </div>
            <div className="mt-4">
              <LeaveDaysTable days={detail.days} timezone={detail.timezone} />
            </div>
            <h3 className="mt-5 text-sm font-semibold text-slate-900">History</h3>
            <div className="mt-2">
              <RequestHistory detail={detail} />
            </div>
          </Panel>
        </div>
      )}
    </PageContainer>
  );
}

function RequestLeaveForm({
  overview,
  busy,
  onPreview,
  onSubmit,
  onError,
}: {
  overview: MyLeaveOverview;
  busy: string | null;
  onPreview(input: LeaveRequestInput): Promise<LeavePreview>;
  onSubmit(input: LeaveRequestInput): Promise<boolean>;
  onError(cause: unknown): void;
}) {
  const requestable = overview.assignments.filter((a) => a.actions.canRequest);
  const [assignmentId, setAssignmentId] = useState(requestable[0]?.employmentAssignmentId ?? '');
  const assignment =
    requestable.find((a) => a.employmentAssignmentId === assignmentId) ?? requestable[0];
  const types = assignment?.leaveTypes.filter((t) => t.actions.canRequest) ?? [];
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const type = types.find((t) => t.leaveType.id === leaveTypeId) ?? types[0];
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [partial, setPartial] = useState(false);
  const [startLocalTime, setStartLocalTime] = useState('');
  const [endLocalTime, setEndLocalTime] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  if (requestable.length === 0 || !assignment) {
    return <EmptyState>You have no assignment on which you can request leave.</EmptyState>;
  }
  if (!type) return <EmptyState>No leave types are available for this assignment.</EmptyState>;

  const allowPartial = type.policy?.allowPartialDay ?? false;
  // A partial day only counts while the chosen type allows it; otherwise the full range applies.
  const isPartial = partial && allowPartial;
  const input = (): LeaveRequestInput => ({
    employmentAssignmentId: assignment.employmentAssignmentId,
    leaveTypeId: type.leaveType.id,
    startDate,
    endDate: isPartial ? startDate : endDate || startDate,
    ...(isPartial ? { startLocalTime, endLocalTime } : {}),
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  });
  // Any edit invalidates the preview: what is submitted is always what was previewed.
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPreview(null);
    };

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    setPreviewing(true);
    try {
      setPreview(await onPreview(input()));
    } catch (cause) {
      setPreview(null);
      onError(cause);
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <form
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      onSubmit={(event) => void runPreview(event)}
    >
      {requestable.length > 1 && (
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">
          Assignment
          <select
            value={assignment.employmentAssignmentId}
            onChange={(e) => {
              edit(setAssignmentId)(e.target.value);
              setPartial(false);
            }}
            className={inputClass}
          >
            {requestable.map((a) => (
              <option key={a.employmentAssignmentId} value={a.employmentAssignmentId}>
                {a.position.name} · {a.organization.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="text-sm font-medium text-slate-700 sm:col-span-2">
        Leave type
        <select
          value={type.leaveType.id}
          onChange={(e) => {
            edit(setLeaveTypeId)(e.target.value);
            setPartial(false);
          }}
          className={inputClass}
        >
          {types.map((t) => (
            <option key={t.leaveType.id} value={t.leaveType.id}>
              {t.leaveType.name} ({label(t.leaveType.classification)})
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">
        Start date
        <input
          type="date"
          required
          value={startDate}
          onChange={(e) => edit(setStartDate)(e.target.value)}
          className={inputClass}
        />
      </label>
      {!isPartial && (
        <label className="text-sm font-medium text-slate-700">
          End date
          <input
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => edit(setEndDate)(e.target.value)}
            className={inputClass}
          />
        </label>
      )}
      {allowPartial && (
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 sm:col-span-2">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={partial}
            onChange={(e) => edit(setPartial)(e.target.checked)}
          />
          Partial day
        </label>
      )}
      {isPartial && (
        <>
          <label className="text-sm font-medium text-slate-700">
            From
            <input
              type="time"
              required
              value={startLocalTime}
              onChange={(e) => edit(setStartLocalTime)(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            To
            <input
              type="time"
              required
              value={endLocalTime}
              onChange={(e) => edit(setEndLocalTime)(e.target.value)}
              className={inputClass}
            />
          </label>
        </>
      )}
      <label className="text-sm font-medium text-slate-700 sm:col-span-2">
        Reason (optional)
        <textarea
          value={reason}
          rows={2}
          maxLength={2000}
          onChange={(e) => edit(setReason)(e.target.value)}
          className={inputClass}
        />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={previewing || !startDate} className={secondaryButton}>
          {previewing ? 'Calculating…' : 'Preview'}
        </button>
        {preview && (
          <button
            type="button"
            disabled={
              busy === 'submit' || (preview.balance !== null && !preview.balance.sufficient)
            }
            className={primaryButton}
            onClick={() =>
              void onSubmit(input()).then((ok) => {
                if (ok) {
                  setPreview(null);
                  setStartDate('');
                  setEndDate('');
                  setReason('');
                }
              })
            }
          >
            {busy === 'submit'
              ? 'Submitting…'
              : `Submit ${formatLeaveAmount(preview.totalMinutes, type.leaveType.displayUnit)}`}
          </button>
        )}
      </div>
      {preview && (
        <div className="space-y-3 sm:col-span-2" role="group" aria-label="Leave preview">
          <p className="text-sm text-slate-700">
            Total{' '}
            <strong>{formatLeaveAmount(preview.totalMinutes, type.leaveType.displayUnit)}</strong>
            {preview.balance && (
              <>
                {' '}
                · left for the leave year{' '}
                {formatLeaveRange(
                  preview.balance.leaveYear.start,
                  preview.balance.leaveYear.end,
                )}{' '}
                after approval{' '}
                <strong>
                  {formatLeaveAmount(
                    preview.balance.availableAfterMinutes,
                    type.leaveType.displayUnit,
                  )}
                </strong>
              </>
            )}
          </p>
          {preview.balance && !preview.balance.sufficient && (
            <ErrorBanner>This leave exceeds the balance available for its leave year.</ErrorBanner>
          )}
          <LeaveDaysTable days={preview.days} timezone={preview.timezone} />
        </div>
      )}
    </form>
  );
}

function MyRequestsTable({
  requests,
  busy,
  onDetails,
  onCancel,
}: {
  requests: MyLeaveRequest[];
  busy: string | null;
  onDetails(id: string): void;
  onCancel(request: MyLeaveRequest): void;
}) {
  // Batch 10B: the shared DataTable (a named, keyboard-scrollable region; the dates head each row).
  return (
    <DataTable
      bare
      label="My leave requests"
      minWidth="min-w-[560px]"
      rows={requests}
      rowKey={(request) => request.id}
      empty="No leave requests yet."
      columns={[
        {
          key: 'dates',
          header: 'Dates',
          rowHeader: true,
          cell: (request) =>
            formatLeaveRange(
              request.startDate,
              request.endDate,
              request.startLocalTime,
              request.endLocalTime,
            ),
        },
        { key: 'type', header: 'Type', cell: (request) => request.leaveType.name },
        {
          key: 'amount',
          header: 'Amount',
          cell: (request) =>
            formatLeaveAmount(
              request.activeMinutes ?? request.requestedMinutes,
              request.leaveType.displayUnit,
            ),
        },
        {
          key: 'status',
          header: 'Status',
          cell: (request) => <LeaveStatusPill value={request.status} />,
        },
        {
          key: 'actions',
          header: 'Actions',
          cell: (request) => (
            <div className="flex gap-2">
              <button
                type="button"
                className={secondaryButton}
                disabled={busy === `detail-${request.id}`}
                aria-label={`Details: ${request.leaveType.name}, ${formatLeaveRange(request.startDate, request.endDate, request.startLocalTime, request.endLocalTime)}`}
                onClick={() => onDetails(request.id)}
              >
                Details
              </button>
              {request.actions.canCancel && (
                <button
                  type="button"
                  className={dangerButton}
                  disabled={busy === `cancel-${request.id}`}
                  onClick={() => onCancel(request)}
                >
                  {request.status === 'PENDING' ? 'Withdraw' : 'Cancel'}
                </button>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
