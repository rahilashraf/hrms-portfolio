'use client';

import { useState } from 'react';
import { onboardingApi } from '../../../lib/onboarding/api';
import type {
  CompletionOutcome,
  ImportReferenceType,
  WorkflowKind,
} from '../../../lib/onboarding/types';
import {
  Field,
  inputClass,
  KIND_LABELS,
  label,
  primaryButton,
  REFERENCE_TYPE_LABELS,
} from '../onboarding-shared';
import { Mutate } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: moved from onboarding-admin-page.tsx unchanged.
const IMPORT_TYPES: ImportReferenceType[] = ['GOOGLE_FORM', 'GOOGLE_DOC', 'EXTERNAL_URL'];

export function ImportTab({
  organizationId,
  kinds,
  busy,
  mutate,
}: {
  organizationId: string;
  /** The workflow kinds this user manages organization-wide: the only ones an import completes. */
  kinds: WorkflowKind[];
  busy: boolean;
  mutate: Mutate;
}) {
  const [referenceType, setReferenceType] = useState<ImportReferenceType>('GOOGLE_FORM');
  const [payload, setPayload] = useState('[]');
  const [invalid, setInvalid] = useState(false);
  const [outcomes, setOutcomes] = useState<CompletionOutcome[] | null>(null);
  return (
    <form
      aria-label="Import task completions"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        let submissions: unknown[];
        try {
          const parsed: unknown = JSON.parse(payload);
          if (!Array.isArray(parsed)) throw new Error('not an array');
          submissions = parsed;
        } catch {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        void mutate(async () => {
          setOutcomes(
            (await onboardingApi.importCompletions({ organizationId, referenceType, submissions }))
              .outcomes,
          );
        }, 'Completions imported.');
      }}
    >
      <h2 className="text-base font-semibold text-slate-900">Import external task completions</h2>
      <p className="text-sm text-slate-600">
        Completes employees’ open tasks that reference the submitted resource (for example a Google
        Form id), matched by the respondent’s email. Acknowledgements are never completed
        externally, and a response completes a task only once.
      </p>
      <p className="text-sm text-slate-600">
        Completes {kinds.map((kind) => KIND_LABELS[kind].toLowerCase()).join(' and ')} tasks only —
        the workflow kinds you manage for the whole organization.
      </p>
      <Field label="Reference type">
        <select
          className={inputClass}
          value={referenceType}
          onChange={(e) => setReferenceType(e.currentTarget.value as ImportReferenceType)}
        >
          {IMPORT_TYPES.map((type) => (
            <option key={type} value={type}>
              {REFERENCE_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Submissions (JSON array of { externalResourceId, externalResponseId, respondentEmail, submittedAt })">
        <textarea
          className={inputClass}
          rows={6}
          value={payload}
          onChange={(e) => setPayload(e.currentTarget.value)}
        />
      </Field>
      {invalid && (
        <p role="alert" className="text-sm text-rose-800">
          Enter a JSON array of submissions.
        </p>
      )}
      <button type="submit" className={primaryButton} disabled={busy}>
        Import
      </button>
      {outcomes && (
        <DataTable
          label="Import outcomes"
          empty="The import returned no outcomes."
          rows={outcomes}
          rowKey={(outcome, index) => `${outcome.externalResponseId}-${index}`}
          columns={[
            {
              key: 'response',
              header: 'Response',
              rowHeader: true,
              cell: (outcome) => outcome.externalResponseId || '—',
            },
            { key: 'outcome', header: 'Outcome', cell: (outcome) => label(outcome.outcome) },
            {
              key: 'detail',
              header: 'Detail',
              cell: (outcome) => (outcome.reason ? label(outcome.reason) : (outcome.taskId ?? '—')),
            },
          ]}
        />
      )}
    </form>
  );
}
