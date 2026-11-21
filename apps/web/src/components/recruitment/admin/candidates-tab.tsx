'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import type { Candidate, CandidateSource } from '../../../lib/recruitment/types';
import { EmptyState, Field, inputClass, label, primaryButton } from '../recruitment-shared';
import { Loading, Mutate, SOURCES, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: moved from recruitment-admin-page.tsx unchanged.
export function CandidatesTab({
  organizationId,
  canCreate,
  search,
  onSearch,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  canCreate: boolean;
  search: string;
  onSearch(search: string): void;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(
    () => recruitmentApi.candidates(organizationId, { search: search.trim() || undefined }),
    [organizationId, search],
  );
  const { data, loaded } = useData(load, onError);
  const candidates: Candidate[] = data?.items ?? [];
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    preferredName: '',
    email: '',
    phone: '',
    location: '',
    source: 'DIRECT' as CandidateSource,
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="space-y-4">
      <Field label="Search candidates by name or email">
        <input
          className={inputClass}
          type="search"
          value={search}
          onChange={(e) => onSearch(e.currentTarget.value)}
        />
      </Field>
      {!loaded ? (
        <Loading />
      ) : candidates.length === 0 ? (
        <EmptyState>No candidates match.</EmptyState>
      ) : (
        <DataTable
          label="Candidates"
          rows={candidates}
          rowKey={(candidate) => candidate.id}
          columns={[
            {
              key: 'candidate',
              header: 'Candidate',
              rowHeader: true,
              cell: (candidate) => (
                <>
                  {candidate.displayName}
                  {candidate.internal && (
                    <span className="ml-2 text-xs text-indigo-700">Internal</span>
                  )}
                </>
              ),
            },
            {
              key: 'email',
              header: 'Email',
              cell: (candidate) => <>{candidate.email ?? '—'}</>,
            },
            {
              key: 'source',
              header: 'Source',
              cell: (candidate) => <>{label(candidate.source)}</>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (candidate) => <>{label(candidate.status)}</>,
            },
            {
              key: 'applications',
              header: 'Applications',
              cell: (candidate) => <>{candidate.applicationCount ?? 0}</>,
            },
            {
              key: 'open',
              header: <span className="sr-only">Actions</span>,
              cell: (candidate) => (
                <>
                  <Link
                    className="text-indigo-700 underline"
                    href={`/recruitment/candidates/${candidate.id}`}
                    aria-label={`Open candidate ${candidate.displayName}`}
                  >
                    Open
                  </Link>
                </>
              ),
            },
          ]}
        />
      )}
      {canCreate && (
        <form
          aria-label="Add candidate"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              () =>
                recruitmentApi.createCandidate({
                  organizationId,
                  firstName: form.firstName.trim(),
                  lastName: form.lastName.trim(),
                  preferredName: form.preferredName.trim() || null,
                  email: form.email.trim() || null,
                  phone: form.phone.trim() || null,
                  location: form.location.trim() || null,
                  source: form.source,
                }),
              'Candidate added.',
            );
          }}
        >
          <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">New candidate</h2>
          {(
            [
              ['firstName', 'First name', true],
              ['lastName', 'Last name', true],
              ['preferredName', 'Preferred name', false],
              ['email', 'Email', false],
              ['phone', 'Phone', false],
              ['location', 'Location', false],
            ] as const
          ).map(([key, text, required]) => (
            <Field key={key} label={text}>
              <input
                className={inputClass}
                required={required}
                value={form[key]}
                onChange={(e) => set(key)(e.currentTarget.value)}
              />
            </Field>
          ))}
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
          <div className="flex items-end">
            <button type="submit" className={primaryButton} disabled={busy}>
              Add candidate
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
