'use client';

import { PageHeader } from '../ui/page-header';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageContainer } from '../ui/page-container';
import { LoadingState } from '../ui/states';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { recruitmentApi } from '../../lib/recruitment/api';
import { isRecruitmentForbidden, recruitmentErrorMessage } from '../../lib/recruitment/errors';
import type { CandidateDetail } from '../../lib/recruitment/types';
import {
  ActivityTimeline,
  ApplicationStatusBadge,
  dateTimeText,
  DocumentsSection,
  EmptyState,
  Field,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
  Section,
} from './recruitment-shared';
import { ConfirmButton } from '../ui/confirm-button';
import { candidateSource } from '../../lib/pickers/sources';
import { recruitmentOptionSource } from '../../lib/recruitment/pickers';
import { RecordCombobox } from '../ui/record-combobox';
import { DataTable } from '../ui/data-table';

type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

/**
 * A candidate profile: identity (a Recruitment-owned record, never a Person until hire), the
 * internal-employee link, readable applications, document references and the timeline; merges
 * are explicit and permanent.
 */
export function CandidatePage({ candidateId }: { candidateId: string }) {
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCandidate(await recruitmentApi.candidate(candidateId));
      setError(null);
    } catch (cause) {
      setForbidden(isRecruitmentForbidden(cause));
      setError(recruitmentErrorMessage(cause, 'Unable to load the candidate.'));
    } finally {
      setLoading(false);
    }
  }, [candidateId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run: Run = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(recruitmentErrorMessage(cause, 'Unable to save the candidate.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <LoadingState label="Loading candidate…" />
      </PageContainer>
    );
  }
  if (forbidden) {
    return (
      <PageContainer padded={false}>
        <Forbidden message="You do not have access to this candidate." />
      </PageContainer>
    );
  }
  if (!candidate) {
    return (
      <PageContainer>
        <ErrorBanner>{error ?? 'Unable to load the candidate.'}</ErrorBanner>
      </PageContainer>
    );
  }
  const { actions } = candidate;
  const active = candidate.status === 'ACTIVE';

  return (
    <PageContainer className="space-y-6">
      <div>
        <Link
          href="/admin/recruitment"
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          ← Recruitment
        </Link>
        <div className="mt-2">
          <PageHeader
            title={candidate.displayName}
            description={
              <>
                {label(candidate.status)} · {label(candidate.source)} · added{' '}
                {dateTimeText(candidate.createdAt)}
                {candidate.hired ? ' · Hired' : ''}
              </>
            }
          />
        </div>
        {candidate.mergedIntoCandidateId && (
          <p className="mt-2 text-sm text-slate-700">
            Merged into{' '}
            <Link
              className="text-indigo-700 underline"
              href={`/recruitment/candidates/${candidate.mergedIntoCandidateId}`}
            >
              another candidate
            </Link>
            .
          </p>
        )}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}

      <IdentitySection candidate={candidate} busy={busy} run={run} />
      <InternalSection candidate={candidate} busy={busy} run={run} />

      <Section title="Applications">
        {candidate.applications.length === 0 ? (
          <EmptyState>No applications.</EmptyState>
        ) : (
          <DataTable
            label={`Applications of ${candidate.displayName}`}
            rows={candidate.applications}
            rowKey={(application) => application.id}
            columns={[
              {
                key: 'opening',
                header: 'Opening',
                rowHeader: true,
                cell: (application) => (
                  <>
                    {application.opening.title}
                    <span className="block text-xs font-normal text-slate-500">
                      {application.opening.code}
                    </span>
                  </>
                ),
              },
              {
                key: 'stage',
                header: 'Stage',
                cell: (application) => <>{application.stage.name}</>,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (application) => (
                  <>
                    <ApplicationStatusBadge status={application.status} />
                  </>
                ),
              },
              {
                key: 'applied',
                header: 'Applied',
                cell: (application) => <>{dateTimeText(application.appliedAt)}</>,
              },
              {
                key: 'open',
                header: <span className="sr-only">Actions</span>,
                cell: (application) => (
                  <>
                    <Link
                      className="text-indigo-700 underline"
                      href={`/recruitment/applications/${application.id}`}
                      aria-label={`Open the application for ${application.opening.title}`}
                    >
                      Open
                    </Link>
                  </>
                ),
              },
            ]}
          />
        )}
      </Section>

      <DocumentsSection
        documents={candidate.documents}
        canManage={actions.canEdit && active}
        busy={busy}
        run={run}
        onAdd={(input) => recruitmentApi.addDocument(candidate.id, input)}
        onRemove={(documentId, reason) => recruitmentApi.removeDocument(documentId, reason)}
      />
      <ActivityTimeline activity={candidate.activity} />
      {actions.canMerge && active && <MergeArchive candidate={candidate} busy={busy} run={run} />}
    </PageContainer>
  );
}

function IdentitySection({
  candidate,
  busy,
  run,
}: {
  candidate: CandidateDetail;
  busy: boolean;
  run: Run;
}) {
  const [form, setForm] = useState({
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    preferredName: candidate.preferredName ?? '',
    email: candidate.email ?? '',
    phone: candidate.phone ?? '',
    location: candidate.location ?? '',
    notes: candidate.notes ?? '',
  });
  const editable = candidate.actions.canEdit && candidate.status === 'ACTIVE';
  const fields = [
    ['firstName', 'First name', true],
    ['lastName', 'Last name', true],
    ['preferredName', 'Preferred name', false],
    ['email', 'Email', false],
    ['phone', 'Phone', false],
    ['location', 'Location', false],
  ] as const;
  if (!editable) {
    return (
      <Section title="Identity">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {fields.map(([key, text]) => (
            <div key={key}>
              <dt className="text-slate-500">{text}</dt>
              <dd>{candidate[key] || '—'}</dd>
            </div>
          ))}
        </dl>
        {candidate.notes && <p className="whitespace-pre-wrap text-sm">{candidate.notes}</p>}
      </Section>
    );
  }
  return (
    <Section title="Identity">
      <form
        aria-label="Edit candidate"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              recruitmentApi.updateCandidate(candidate.id, {
                firstName: form.firstName.trim(),
                lastName: form.lastName.trim(),
                preferredName: form.preferredName.trim() || null,
                email: form.email.trim() || null,
                phone: form.phone.trim() || null,
                location: form.location.trim() || null,
                notes: form.notes.trim() || null,
              }),
            'Candidate updated.',
          );
        }}
      >
        {fields.map(([key, text, required]) => (
          <Field key={key} label={text}>
            <input
              className={inputClass}
              required={required}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.currentTarget.value })}
            />
          </Field>
        ))}
        <div className="sm:col-span-3">
          <Field label="Notes">
            <textarea
              className={inputClass}
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
            />
          </Field>
        </div>
        <div>
          <button type="submit" className={primaryButton} disabled={busy}>
            Save candidate
          </button>
        </div>
      </form>
    </Section>
  );
}

function InternalSection({
  candidate,
  busy,
  run,
}: {
  candidate: CandidateDetail;
  busy: boolean;
  run: Run;
}) {
  const [employeeId, setEmployeeId] = useState('');
  // Batch 7A: employees of the organization from GET /recruitment/options (the rule the API
  // checks), so marking an internal candidate needs no employee.read.
  const employees = useMemo(
    () => recruitmentOptionSource(candidate.organizationId, 'hiringManager'),
    [candidate.organizationId],
  );
  const canMark = candidate.actions.canMarkInternal && candidate.status === 'ACTIVE';
  return (
    <Section title="Internal candidate">
      {candidate.internalEmployee ? (
        <p className="text-sm text-slate-800">
          Current employee{' '}
          <Link
            className="text-indigo-700 underline"
            href={`/admin/employees/${candidate.internalEmployee.id}`}
          >
            {candidate.internalEmployee.displayName} ({candidate.internalEmployee.employeeNumber})
          </Link>
        </p>
      ) : (
        <p className="text-sm text-slate-600">Not linked to an employee (external candidate).</p>
      )}
      {canMark && (
        <div className="flex flex-wrap items-end gap-2">
          <RecordCombobox
            className="min-w-64"
            label="Employee"
            source={employees}
            value={employeeId}
            onChange={(id) => setEmployeeId(id)}
            placeholder="Name or employee number"
            noResultsText="No matching employees of the organization."
          />
          <button
            type="button"
            className={secondaryButton}
            disabled={busy || !employeeId.trim()}
            onClick={() =>
              void run(
                () => recruitmentApi.setInternalEmployee(candidate.id, employeeId.trim()),
                'Candidate linked to the employee.',
              )
            }
          >
            Mark as internal
          </button>
          {candidate.internalEmployee && (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() =>
                void run(
                  () => recruitmentApi.setInternalEmployee(candidate.id, null),
                  'Employee link removed.',
                )
              }
            >
              Remove employee link
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

function MergeArchive({
  candidate,
  busy,
  run,
}: {
  candidate: CandidateDetail;
  busy: boolean;
  run: Run;
}) {
  const [intoId, setIntoId] = useState('');
  const others = useMemo(
    () => candidateSource(candidate.organizationId, { excludeId: candidate.id }),
    [candidate.organizationId, candidate.id],
  );
  return (
    <section
      aria-label="Merge or archive"
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
    >
      <h2 className="text-base font-semibold text-slate-900">Merge or archive</h2>
      <p className="text-sm text-slate-600">
        Merging moves this candidate&apos;s applications and documents to the other candidate. It is
        recorded and cannot be undone.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <RecordCombobox
          className="min-w-64"
          label="Merge into candidate"
          source={others}
          value={intoId}
          onChange={(id) => setIntoId(id)}
          placeholder="Search by name or email"
          noResultsText="No other matching candidates."
          manualEntry={{ label: 'Candidate ID' }}
        />
        <button
          type="button"
          className={secondaryButton}
          disabled={busy || !intoId.trim()}
          onClick={() =>
            void run(
              () => recruitmentApi.mergeCandidate(candidate.id, intoId.trim()),
              'Candidate merged.',
            )
          }
        >
          Merge candidate
        </button>
        <ConfirmButton
          className={secondaryButton}
          disabled={busy}
          confirm={{
            title: 'Archive this candidate?',
            description:
              'The candidate leaves the active candidate lists; their past applications are kept.',
            confirmLabel: 'Archive candidate',
          }}
          onConfirm={() =>
            void run(() => recruitmentApi.archiveCandidate(candidate.id), 'Candidate archived.')
          }
        >
          Archive candidate
        </ConfirmButton>
      </div>
    </section>
  );
}
