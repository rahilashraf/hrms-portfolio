'use client';

import { useMemo, useState } from 'react';
import { performanceApi, type ManualEvidenceInput } from '../../../lib/performance/api';
import { performanceOptionSource } from '../../../lib/performance/pickers';
import type { Evidence, EvidenceKind, EvidenceRevision } from '../../../lib/performance/types';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import { useConfirmWithReason } from '../../ui/use-confirm';
import {
  dateTimeText,
  EmptyState,
  inputClass,
  label,
  primaryButton,
  PROVIDER_LABELS,
  scoreText,
  secondaryButton,
} from '../performance-shared';
import { EVIDENCE_KINDS } from './evidence-sources';
import { Field, SectionState, useSectionData, type SectionProps } from './shared';
import { DataTable } from '../../ui/data-table';

type ManualProvider = ManualEvidenceInput['provider'];
const MANUAL_PROVIDERS: ManualProvider[] = ['MANUAL', 'TRAINING', 'CERTIFICATION', 'OTHER'];
/** A date (no time) recorded as midday UTC, so it reads as that day in every time zone. */
const middayUtc = (date: string) => `${date}T12:00:00.000Z`;
const hasNotes = (evidence: Evidence) => evidence.notes !== undefined;

/** Evidence recorded by HR, and an employee's evidence: correct, re-map, withdraw, history. */
export function EvidenceRecordsTab({ organizationId, busy, mutate, version }: SectionProps) {
  const [employee, setEmployee] = useState<{ id: string; label: string } | null>(null);
  const employees = useMemo(
    () => performanceOptionSource(organizationId, 'employee'),
    [organizationId],
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Evidence supports reviews; it never decides a rating. Corrections keep every earlier
        revision in the history.
      </p>
      <RecordEvidenceForm organizationId={organizationId} busy={busy} mutate={mutate} />
      <section
        aria-label="Employee evidence"
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      >
        <h2 className="text-base font-semibold text-slate-900">Employee evidence</h2>
        <RecordCombobox
          label="Employee"
          source={employees}
          value={employee?.id ?? ''}
          onChange={(id, option) => setEmployee(id ? { id, label: option?.label ?? id } : null)}
          placeholder="Name or employee number"
          noResultsText="No matching employees within your access."
        />
        {employee && (
          <EmployeeEvidence
            key={employee.id}
            organizationId={organizationId}
            employee={employee}
            busy={busy}
            mutate={mutate}
            version={version}
          />
        )}
      </section>
    </div>
  );
}

function RecordEvidenceForm({
  organizationId,
  busy,
  mutate,
}: {
  organizationId: string;
  busy: boolean;
  mutate: SectionProps['mutate'];
}) {
  const blank = {
    employeeId: '',
    assignmentId: '',
    provider: 'CERTIFICATION' as ManualProvider,
    kind: 'CERTIFICATION' as EvidenceKind,
    title: '',
    completedOn: '',
    score: '',
    maxScore: '',
    passed: '' as '' | 'yes' | 'no',
    resultUrl: '',
    notes: '',
  };
  const [form, setForm] = useState(blank);
  const [formKey, setFormKey] = useState(0);
  const employees = useMemo(
    () => performanceOptionSource(organizationId, 'employee'),
    [organizationId],
  );
  const assignments = useMemo(
    () =>
      performanceOptionSource(organizationId, 'assignment', {
        employeeId: form.employeeId || undefined,
      }),
    [organizationId, form.employeeId],
  );
  return (
    <form
      key={formKey}
      aria-label="Record evidence"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!form.employeeId) return;
        const ok = await mutate(
          () =>
            performanceApi.recordEvidence({
              organizationId,
              employeeId: form.employeeId,
              employmentAssignmentId: form.assignmentId || null,
              provider: form.provider,
              kind: form.kind,
              title: form.title.trim(),
              completedAt: middayUtc(form.completedOn),
              score: form.score.trim() || null,
              maxScore: form.maxScore.trim() || null,
              passed: form.passed === '' ? null : form.passed === 'yes',
              resultUrl: form.resultUrl.trim() || null,
              notes: form.notes.trim() || null,
            }),
          'Evidence recorded.',
        );
        if (ok) {
          setForm(blank);
          setFormKey((k) => k + 1);
        }
      }}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">Record evidence</h2>
      <RecordCombobox
        label="Employee"
        required
        source={employees}
        value={form.employeeId}
        onChange={(id) => setForm({ ...form, employeeId: id, assignmentId: '' })}
        placeholder="Name or employee number"
        noResultsText="No matching employees within your access."
      />
      <RecordCombobox
        key={form.employeeId || 'none'}
        label="Assignment (optional)"
        hint="Choose an employee first."
        source={assignments}
        value={form.assignmentId}
        disabled={!form.employeeId}
        onChange={(id) => setForm({ ...form, assignmentId: id })}
        placeholder="Position"
        noResultsText="No assignments of this employee."
      />
      <Field label="Provider">
        <select
          className={inputClass}
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.currentTarget.value as ManualProvider })}
        >
          {MANUAL_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Kind">
        <select
          className={inputClass}
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as EvidenceKind })}
        >
          {EVIDENCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {label(kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input
          className={inputClass}
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
        />
      </Field>
      <Field label="Completed on">
        <input
          type="date"
          className={inputClass}
          required
          value={form.completedOn}
          onChange={(e) => setForm({ ...form, completedOn: e.currentTarget.value })}
        />
      </Field>
      <Field label="Score">
        <input
          className={inputClass}
          inputMode="decimal"
          value={form.score}
          onChange={(e) => setForm({ ...form, score: e.currentTarget.value })}
        />
      </Field>
      <Field label="Out of">
        <input
          className={inputClass}
          inputMode="decimal"
          value={form.maxScore}
          onChange={(e) => setForm({ ...form, maxScore: e.currentTarget.value })}
        />
      </Field>
      <Field label="Result">
        <select
          className={inputClass}
          value={form.passed}
          onChange={(e) => setForm({ ...form, passed: e.currentTarget.value as '' | 'yes' | 'no' })}
        >
          <option value="">Not graded</option>
          <option value="yes">Passed</option>
          <option value="no">Not passed</option>
        </select>
      </Field>
      <Field label="Result link">
        <input
          type="url"
          className={inputClass}
          value={form.resultUrl}
          onChange={(e) => setForm({ ...form, resultUrl: e.currentTarget.value })}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="HR notes (confidential)" hint="Only people who manage evidence see them.">
          <textarea
            className={inputClass}
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
          />
        </Field>
      </div>
      <div className="flex items-end">
        <button type="submit" className={primaryButton} disabled={busy || !form.employeeId}>
          Record evidence
        </button>
      </div>
    </form>
  );
}

function EmployeeEvidence({
  organizationId,
  employee,
  busy,
  mutate,
  version,
}: {
  organizationId: string;
  employee: { id: string; label: string };
  busy: boolean;
  mutate: SectionProps['mutate'];
  version: number;
}) {
  const [status, setStatus] = useState<'ACTIVE' | 'WITHDRAWN' | ''>('ACTIVE');
  const { data, error, loading, reload } = useSectionData(
    async () => (await performanceApi.employeeEvidence(employee.id, status || undefined)).items,
    [employee.id, status, version],
  );
  const [correcting, setCorrecting] = useState<Evidence | null>(null);
  const [remapping, setRemapping] = useState<Evidence | null>(null);
  const [history, setHistory] = useState<Evidence | null>(null);
  const [confirmWithReason, reasonDialog] = useConfirmWithReason();
  const items = data ?? [];
  return (
    <div className="space-y-2">
      {reasonDialog}
      <Field label="Show">
        <select
          className={`${inputClass} sm:w-48`}
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value as typeof status)}
        >
          <option value="ACTIVE">Current evidence</option>
          <option value="WITHDRAWN">Withdrawn</option>
          <option value="">All</option>
        </select>
      </Field>
      <SectionState loading={loading} error={error} onRetry={reload} what="the evidence">
        {items.length === 0 ? (
          <EmptyState>No evidence for {employee.label}.</EmptyState>
        ) : (
          <DataTable
            label={`Evidence of ${employee.label}`}
            minWidth="min-w-[760px]"
            rows={items}
            rowKey={(evidence) => evidence.id}
            columns={[
              {
                key: 'evidence',
                header: 'Evidence',
                rowHeader: true,
                cell: (evidence) => (
                  <>
                    {evidence.title}
                    <span className="block text-xs font-normal text-slate-500">
                      {label(evidence.kind)} · revision {evidence.revision}
                      {evidence.employmentAssignment?.positionName
                        ? ` · ${evidence.employmentAssignment.positionName}`
                        : ''}
                    </span>
                    {hasNotes(evidence) && evidence.notes && (
                      <span className="block text-xs font-normal text-slate-700">
                        Notes: {evidence.notes}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'completed',
                header: 'Completed',
                cell: (evidence) => <>{dateTimeText(evidence.completedAt)}</>,
              },
              {
                key: 'result',
                header: 'Result',
                cell: (evidence) => <>{scoreText(evidence)}</>,
              },
              {
                key: 'source',
                header: 'Source',
                cell: (evidence) => (
                  <>
                    {PROVIDER_LABELS[evidence.provider]}
                    <span className="block text-xs font-normal text-slate-500">
                      {evidence.sourceName ?? label(evidence.channel)}
                    </span>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (evidence) => (
                  <>
                    {evidence.status === 'ACTIVE' ? 'Current' : 'Withdrawn'}
                    {evidence.withdrawalReason && (
                      <span className="block text-xs font-normal text-slate-600">
                        {evidence.withdrawalReason}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                className: 'space-x-1 space-y-1',
                cell: (evidence) => (
                  <>
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={`History of ${evidence.title}`}
                      onClick={() => setHistory(evidence)}
                    >
                      History
                    </button>
                    {evidence.status === 'ACTIVE' && evidence.actions?.canManage !== false && (
                      <>
                        {evidence.channel === 'MANUAL' && (
                          <button
                            type="button"
                            className={secondaryButton}
                            disabled={busy}
                            aria-label={`Correct ${evidence.title}`}
                            onClick={() => setCorrecting(evidence)}
                          >
                            Correct
                          </button>
                        )}
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Move ${evidence.title} to another employee`}
                          onClick={() => setRemapping(evidence)}
                        >
                          Re-map
                        </button>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Withdraw ${evidence.title}`}
                          onClick={async () => {
                            const reason = await confirmWithReason({
                              title: `Withdraw ${evidence.title}?`,
                              description:
                                'It no longer counts as evidence and leaves the reviews it supports. The record and its history are kept.',
                              confirmLabel: 'Withdraw evidence',
                              reason: { label: 'Reason', required: true, maxLength: 500 },
                            });
                            if (reason)
                              void mutate(
                                () => performanceApi.withdrawEvidence(evidence.id, reason),
                                'Evidence withdrawn.',
                              );
                          }}
                        >
                          Withdraw
                        </button>
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </SectionState>
      {evidenceDialogs()}
    </div>
  );

  function evidenceDialogs() {
    return (
      <>
        {correcting && (
          <CorrectEvidenceDialog
            evidence={correcting}
            busy={busy}
            mutate={mutate}
            onClose={() => setCorrecting(null)}
          />
        )}
        {remapping && (
          <RemapEvidenceDialog
            organizationId={organizationId}
            evidence={remapping}
            busy={busy}
            mutate={mutate}
            onClose={() => setRemapping(null)}
          />
        )}
        {history && <HistoryDialog evidence={history} onClose={() => setHistory(null)} />}
      </>
    );
  }
}

/** Correction of manually recorded evidence (a new revision; the reason is required). */
function CorrectEvidenceDialog({
  evidence,
  busy,
  mutate,
  onClose,
}: {
  evidence: Evidence;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [form, setForm] = useState({
    title: evidence.title,
    completedOn: evidence.completedAt.slice(0, 10),
    score: evidence.score ?? '',
    maxScore: evidence.maxScore ?? '',
    passed: (evidence.passed === null ? '' : evidence.passed ? 'yes' : 'no') as '' | 'yes' | 'no',
    resultUrl: evidence.resultUrl ?? '',
    notes: evidence.notes ?? '',
    reason: '',
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Correct ${evidence.title}`}
      description="The correction becomes a new revision; the earlier one stays in the history."
      submitLabel="Save correction"
      busy={busy}
      canSubmit={form.title.trim() !== '' && form.reason.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const ok = await mutate(
          () =>
            performanceApi.correctEvidence(evidence.id, {
              title: form.title.trim(),
              completedAt:
                form.completedOn === evidence.completedAt.slice(0, 10)
                  ? evidence.completedAt
                  : middayUtc(form.completedOn),
              score: form.score.trim() || null,
              maxScore: form.maxScore.trim() || null,
              passed: form.passed === '' ? null : form.passed === 'yes',
              resultUrl: form.resultUrl.trim() || null,
              ...(hasNotes(evidence) ? { notes: form.notes.trim() || null } : {}),
              reason: form.reason.trim(),
            }),
          'Evidence corrected.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input
            className={inputClass}
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
          />
        </Field>
        <Field label="Completed on">
          <input
            type="date"
            className={inputClass}
            required
            value={form.completedOn}
            onChange={(e) => setForm({ ...form, completedOn: e.currentTarget.value })}
          />
        </Field>
        <Field label="Score">
          <input
            className={inputClass}
            inputMode="decimal"
            value={form.score}
            onChange={(e) => setForm({ ...form, score: e.currentTarget.value })}
          />
        </Field>
        <Field label="Out of">
          <input
            className={inputClass}
            inputMode="decimal"
            value={form.maxScore}
            onChange={(e) => setForm({ ...form, maxScore: e.currentTarget.value })}
          />
        </Field>
        <Field label="Result">
          <select
            className={inputClass}
            value={form.passed}
            onChange={(e) =>
              setForm({ ...form, passed: e.currentTarget.value as '' | 'yes' | 'no' })
            }
          >
            <option value="">Not graded</option>
            <option value="yes">Passed</option>
            <option value="no">Not passed</option>
          </select>
        </Field>
        <Field label="Result link">
          <input
            type="url"
            className={inputClass}
            value={form.resultUrl}
            onChange={(e) => setForm({ ...form, resultUrl: e.currentTarget.value })}
          />
        </Field>
        {hasNotes(evidence) && (
          <div className="sm:col-span-2">
            <Field label="HR notes (confidential)">
              <textarea
                className={inputClass}
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
              />
            </Field>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label="Reason for the correction">
            <input
              className={inputClass}
              required
              maxLength={500}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })}
            />
          </Field>
        </div>
      </div>
    </FormDialog>
  );
}

/** Moves evidence recorded against the wrong person (pickers; the reason is required). */
function RemapEvidenceDialog({
  organizationId,
  evidence,
  busy,
  mutate,
  onClose,
}: {
  organizationId: string;
  evidence: Evidence;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [assignmentId, setAssignmentId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const employees = useMemo(
    () => performanceOptionSource(organizationId, 'employee'),
    [organizationId],
  );
  const assignments = useMemo(
    () => performanceOptionSource(organizationId, 'assignment', { employeeId }),
    [organizationId, employeeId],
  );
  return (
    <FormDialog
      open
      title={`Re-map ${evidence.title}`}
      description={`Currently on ${evidence.employee?.displayName ?? 'this employee'}. It moves to the chosen employee; the history keeps where it was.`}
      submitLabel="Re-map evidence"
      busy={busy}
      canSubmit={employeeId !== '' && reason.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const ok = await mutate(
          () =>
            performanceApi.remapEvidence(evidence.id, {
              employeeId,
              employmentAssignmentId: assignmentId || null,
              reason: reason.trim(),
            }),
          'Evidence re-mapped.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <RecordCombobox
          label="Move to employee"
          required
          source={employees}
          value={employeeId}
          onChange={(id) => {
            setEmployeeId(id);
            setAssignmentId('');
          }}
          placeholder="Name or employee number"
          noResultsText="No matching employees within your access."
        />
        {employeeId && (
          <RecordCombobox
            key={employeeId}
            label="Assignment (optional)"
            source={assignments}
            value={assignmentId}
            onChange={(id) => setAssignmentId(id)}
            placeholder="Position"
            noResultsText="No assignments of this employee."
          />
        )}
        <Field label="Reason">
          <input
            className={inputClass}
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function HistoryDialog({ evidence, onClose }: { evidence: Evidence; onClose(): void }) {
  const { data, error, loading, reload } = useSectionData(
    async () => (await performanceApi.evidenceHistory(evidence.id)).items,
    [evidence.id],
  );
  return (
    <FormDialog
      open
      size="lg"
      title={`History of ${evidence.title}`}
      submitLabel="Done"
      cancelLabel="Close"
      busy={false}
      canSubmit
      error={null}
      onClose={onClose}
      onSubmit={onClose}
    >
      <SectionState loading={loading} error={error} onRetry={reload} what="the history">
        {(data ?? []).length === 0 ? (
          <EmptyState>No earlier revisions.</EmptyState>
        ) : (
          <ol aria-label="Revisions" className="space-y-2">
            {(data ?? []).map((revision: EvidenceRevision) => (
              <li
                key={`${revision.id}-${revision.revision}`}
                className="rounded-lg border border-slate-200 p-3 text-sm"
              >
                <p className="font-medium text-slate-900">
                  Revision {revision.revision}: {revision.title}
                </p>
                <p className="text-slate-700">
                  {dateTimeText(revision.completedAt)} · {scoreText(revision)} ·{' '}
                  {revision.employee?.displayName ?? ''}
                  {revision.status === 'WITHDRAWN' ? ' · withdrawn' : ''}
                </p>
                <p className="text-xs text-slate-600">
                  Recorded by {revision.recordedBy?.displayName ?? 'an import or synchronization'}
                  {revision.supersededAt
                    ? ` · superseded ${dateTimeText(revision.supersededAt)}`
                    : ' · current'}
                </p>
                {revision.correctionReason && (
                  <p className="text-xs text-slate-700">Reason: {revision.correctionReason}</p>
                )}
                {revision.withdrawalReason && (
                  <p className="text-xs text-slate-700">Withdrawn: {revision.withdrawalReason}</p>
                )}
                {revision.notes !== undefined && revision.notes && (
                  <p className="text-xs text-slate-700">Notes: {revision.notes}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </SectionState>
    </FormDialog>
  );
}
