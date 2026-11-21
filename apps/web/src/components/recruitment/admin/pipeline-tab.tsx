'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import type {
  ApplicationStatus,
  ApplicationSummary,
  CandidateSource,
  Opening,
} from '../../../lib/recruitment/types';
import {
  ApplicationStatusBadge,
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  label,
  primaryButton,
} from '../recruitment-shared';
import { candidateSource } from '../../../lib/pickers/sources';
import { RecordCombobox } from '../../ui/record-combobox';
import { Loading, Mutate, SOURCES, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: the applications list and the add-application form (moved from
// recruitment-admin-page.tsx unchanged).
const APPLICATION_STATUSES: ApplicationStatus[] = [
  'ACTIVE',
  'OFFERED',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
];

interface PipelineFilter {
  openingId: string;
  stageId: string;
  status: ApplicationStatus | '';
  search: string;
}

export function PipelineTab({
  organizationId,
  filter,
  onFilter,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  filter: PipelineFilter;
  onFilter(filter: PipelineFilter): void;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const loadOptions = useCallback(async () => {
    const [openings, stages] = await Promise.all([
      recruitmentApi.openings(organizationId),
      recruitmentApi.stages(organizationId),
    ]);
    return { openings: openings.items, stages: stages.items };
  }, [organizationId]);
  const options = useData(loadOptions, onError);
  const load = useCallback(
    () =>
      recruitmentApi.applications(organizationId, {
        openingId: filter.openingId || undefined,
        stageId: filter.stageId || undefined,
        status: filter.status || undefined,
        search: filter.search.trim() || undefined,
      }),
    [organizationId, filter.openingId, filter.stageId, filter.status, filter.search],
  );
  const { data, loaded } = useData(load, onError);
  const openings = options.data?.openings ?? [];
  const stages = options.data?.stages ?? [];
  const items: ApplicationSummary[] = data?.items ?? [];
  const manageable = openings.filter((o) => o.status === 'OPEN' && o.actions?.canManage);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Opening">
          <select
            className={inputClass}
            value={filter.openingId}
            onChange={(e) => onFilter({ ...filter, openingId: e.currentTarget.value })}
          >
            <option value="">All openings</option>
            {openings.map((opening) => (
              <option key={opening.id} value={opening.id}>
                {opening.title} ({opening.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Stage">
          <select
            className={inputClass}
            value={filter.stageId}
            onChange={(e) => onFilter({ ...filter, stageId: e.currentTarget.value })}
          >
            <option value="">All stages</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Application status">
          <select
            className={inputClass}
            value={filter.status}
            onChange={(e) =>
              onFilter({ ...filter, status: e.currentTarget.value as ApplicationStatus | '' })
            }
          >
            <option value="">All statuses</option>
            {APPLICATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search candidates">
          <input
            className={inputClass}
            type="search"
            value={filter.search}
            onChange={(e) => onFilter({ ...filter, search: e.currentTarget.value })}
          />
        </Field>
      </div>
      {!loaded ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState>No applications match.</EmptyState>
      ) : (
        <DataTable
          label="Applications"
          minWidth="min-w-[720px]"
          rows={items}
          rowKey={(application) => application.id}
          columns={[
            {
              key: 'candidate',
              header: 'Candidate',
              rowHeader: true,
              cell: (application) => (
                <>
                  {application.candidate.displayName}
                  {application.candidate.internal && (
                    <span className="ml-2 text-xs text-indigo-700">Internal</span>
                  )}
                </>
              ),
            },
            {
              key: 'opening',
              header: 'Opening',
              cell: (application) => (
                <>
                  {application.opening.title}
                  <span className="block text-xs text-slate-500">{application.opening.code}</span>
                </>
              ),
            },
            {
              key: 'stage',
              header: 'Stage',
              cell: (application) => (
                <>
                  {application.stage.name}
                  <span className="block text-xs text-slate-500">
                    since {dateTimeText(application.stageEnteredAt)}
                  </span>
                </>
              ),
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
                    aria-label={`Open application of ${application.candidate.displayName}`}
                  >
                    Open
                  </Link>
                </>
              ),
            },
          ]}
        />
      )}
      {manageable.length > 0 && (
        <AddApplicationForm openings={manageable} busy={busy} mutate={mutate} />
      )}
    </div>
  );
}

function AddApplicationForm({
  openings,
  busy,
  mutate,
}: {
  openings: Opening[];
  busy: boolean;
  mutate: Mutate;
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [form, setForm] = useState({
    openingId: '',
    candidateId: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    source: 'DIRECT' as CandidateSource,
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Candidates of the chosen opening's organization (the server checks the same).
  const organizationId = (openings.find((opening) => opening.id === form.openingId) ?? openings[0])
    ?.organization.id;
  const candidates = useMemo(
    () => (organizationId ? candidateSource(organizationId) : null),
    [organizationId],
  );
  return (
    <form
      aria-label="Add application"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate(
          () =>
            recruitmentApi.createApplication({
              openingId: form.openingId || openings[0]!.id,
              source: form.source,
              ...(mode === 'existing'
                ? { candidateId: form.candidateId.trim() }
                : {
                    candidate: {
                      firstName: form.firstName.trim(),
                      lastName: form.lastName.trim(),
                      email: form.email.trim() || null,
                      phone: form.phone.trim() || null,
                      source: form.source,
                    },
                  }),
            }),
          'Application added.',
        );
      }}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">Add application</h2>
      <Field label="Apply to opening">
        <select
          className={inputClass}
          value={form.openingId}
          onChange={(e) => set('openingId')(e.currentTarget.value)}
        >
          {openings.map((opening) => (
            <option key={opening.id} value={opening.id}>
              {opening.title} ({opening.code})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Source">
        <select
          className={inputClass}
          value={form.source}
          onChange={(e) => set('source')(e.currentTarget.value)}
        >
          {SOURCES.map((source) => (
            <option key={source} value={source}>
              {label(source)}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="text-sm text-slate-800">
        <legend className="font-medium">Candidate</legend>
        <label className="mr-4 inline-flex items-center gap-1">
          <input
            type="radio"
            name="candidate-mode"
            checked={mode === 'new'}
            onChange={() => setMode('new')}
          />
          New candidate
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="radio"
            name="candidate-mode"
            checked={mode === 'existing'}
            onChange={() => setMode('existing')}
          />
          Existing candidate
        </label>
      </fieldset>
      {mode === 'existing' ? (
        candidates ? (
          <RecordCombobox
            label="Candidate"
            required
            source={candidates}
            value={form.candidateId}
            onChange={(id) => set('candidateId')(id)}
            placeholder="Search by name or email"
            noResultsText="No matching candidates."
            manualEntry={{ label: 'Candidate ID' }}
          />
        ) : (
          <p className="text-sm text-slate-600">Choose the opening first.</p>
        )
      ) : (
        <>
          <Field label="First name">
            <input
              className={inputClass}
              required
              value={form.firstName}
              onChange={(e) => set('firstName')(e.currentTarget.value)}
            />
          </Field>
          <Field label="Last name">
            <input
              className={inputClass}
              required
              value={form.lastName}
              onChange={(e) => set('lastName')(e.currentTarget.value)}
            />
          </Field>
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              value={form.email}
              onChange={(e) => set('email')(e.currentTarget.value)}
            />
          </Field>
          <Field label="Phone">
            <input
              className={inputClass}
              value={form.phone}
              onChange={(e) => set('phone')(e.currentTarget.value)}
            />
          </Field>
        </>
      )}
      <div className="flex items-end sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy}>
          Add application
        </button>
      </div>
    </form>
  );
}
