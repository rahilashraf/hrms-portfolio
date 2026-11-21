'use client';

import { useEffect, useState } from 'react';
import { documentsApi } from '../../../lib/documents/api';
import { documentsErrorMessage } from '../../../lib/documents/errors';
import type { DocumentType, Policy, PolicyTracking } from '../../../lib/documents/types';
import {
  dateTimeText,
  EmptyState,
  Field,
  formatDateOnly,
  inputClass,
  label,
  PolicyStatusBadge,
  primaryButton,
  ReferenceFields,
  referenceInput,
  referenceProblem,
  ReferenceText,
  saveWithUpload,
  secondaryButton,
  useVersionForm,
  VersionStateBadge,
} from '../documents-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { Loading, type Mutate } from './admin-shared';
import { PolicyEditor } from './policy-editor';
import { DataTable } from '../../ui/data-table';

// Batch 10E-2: one policy: versions, drafts, copies and acknowledgement tracking (moved
// from documents-admin-page.tsx unchanged).
export function PolicyPanel({
  policy,
  types,
  version,
  canManage,
  busy,
  mutate,
}: {
  policy: Policy;
  types: DocumentType[];
  version: number;
  canManage: boolean;
  busy: boolean;
  mutate: Mutate;
}) {
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const retired = policy.status === 'RETIRED';
  const hasDraft = policy.versions.some((v) => v.state === 'DRAFT');
  return (
    <section
      aria-label={`Policy ${policy.title}`}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-slate-900">{policy.title}</h2>
        <PolicyStatusBadge status={policy.status} />
        <span className="text-xs text-slate-500">
          {policy.code}
          {policy.audience.employmentType ? ` · ${label(policy.audience.employmentType)}` : ''}
          {policy.audience.departmentId
            ? ` · Department ${policy.audience.departmentName ?? '(unavailable)'}`
            : ''}
        </span>
      </div>
      {policy.description && (
        <p className="whitespace-pre-line text-sm text-slate-700">{policy.description}</p>
      )}
      {canManage && !retired && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} onClick={() => setEditing(!editing)}>
            Edit policy
          </button>
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: 'Retire this policy?',
              description:
                'Employees are no longer asked to acknowledge it. Its published versions and the acknowledgements already given are kept.',
              confirmLabel: 'Retire policy',
            }}
            onConfirm={() =>
              void mutate(() => documentsApi.retirePolicy(policy.id), 'Policy retired.')
            }
          >
            Retire policy
          </ConfirmButton>
        </div>
      )}
      {canManage && retired && (
        <div className="space-y-2">
          <p className="text-xs text-slate-600">
            A retired policy stays retired; its versions and acknowledgements are kept. To bring it
            back, copy it into a new draft policy and add a version.
          </p>
          {copying ? (
            <CopyPolicyForm
              policy={policy}
              busy={busy}
              mutate={mutate}
              onDone={() => setCopying(false)}
            />
          ) : (
            <button type="button" className={secondaryButton} onClick={() => setCopying(true)}>
              Copy into a new draft
            </button>
          )}
        </div>
      )}
      {editing && (
        <PolicyEditor
          organizationId={policy.organizationId}
          policy={policy}
          types={types}
          busy={busy}
          mutate={mutate}
          onDone={() => setEditing(false)}
        />
      )}
      <h3 className="text-sm font-semibold uppercase text-slate-500">Versions</h3>
      {policy.versions.length === 0 ? (
        <EmptyState>No versions yet.</EmptyState>
      ) : (
        <DataTable
          label="Policy versions"
          minWidth="min-w-[760px]"
          rows={policy.versions}
          rowKey={(item) => item.id}
          columns={[
            {
              key: 'version',
              header: 'Version',
              rowHeader: true,
              cell: (item) => (
                <>
                  {item.versionNumber}. {item.versionLabel}
                  {item.acknowledgementStatement && (
                    <span className="block max-w-xs text-xs text-slate-500">
                      “{item.acknowledgementStatement}”
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'state',
              header: 'State',
              cell: (item) => (
                <>
                  <VersionStateBadge state={item.state} />
                </>
              ),
            },
            {
              key: 'effective',
              header: 'Effective',
              cell: (item) => <>{formatDateOnly(item.effectiveOn)}</>,
            },
            {
              key: 'published',
              header: 'Published',
              cell: (item) => <>{dateTimeText(item.publishedAt)}</>,
            },
            {
              key: 'reference',
              header: 'Reference',
              cell: (item) => (
                <>
                  <ReferenceText
                    reference={item}
                    text={`Open ${item.versionLabel}`}
                    name={`${policy.title} ${item.versionLabel}`}
                    getLink={() => documentsApi.policyVersionDownload(policy.id, item.id)}
                  />
                </>
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              cell: (item) => (
                <>
                  {canManage && !retired && item.state === 'DRAFT' && (
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={`Publish ${item.versionLabel}`}
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () => documentsApi.publishPolicyVersion(policy.id, item.id),
                          'Version published. Employees acknowledge it anew.',
                        )
                      }
                    >
                      Publish
                    </button>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {canManage && !retired && !hasDraft && (
        <DraftVersionForm policy={policy} busy={busy} mutate={mutate} />
      )}
      {canManage && hasDraft && !retired && (
        <p className="text-xs text-slate-600">
          Publish the draft before adding another version. Publishing supersedes the current
          version; a published version never changes.
        </p>
      )}
      <TrackingSection policyId={policy.id} version={version} />
    </section>
  );
}

function DraftVersionForm({
  policy,
  busy,
  mutate,
}: {
  policy: Policy;
  busy: boolean;
  mutate: Mutate;
}) {
  const [versionLabel, setVersionLabel] = useState('');
  const [statement, setStatement] = useState('');
  const [effectiveOn, setEffectiveOn] = useState('');
  const { form: reference, update, uploads, uploader } = useVersionForm();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-label="Create draft version"
      className="grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const found =
          referenceProblem(reference, false, uploads) ??
          (policy.acknowledgementRequired && !statement.trim()
            ? 'A policy that needs acknowledgement states what employees acknowledge.'
            : null);
        setProblem(found);
        if (found) return;
        void mutate(
          () =>
            saveWithUpload(
              reference,
              update,
              { kind: 'policy', policyId: policy.id },
              uploader,
              (uploadId) =>
                documentsApi.createPolicyVersion(policy.id, {
                  versionLabel: versionLabel.trim(),
                  acknowledgementStatement: statement.trim() || null,
                  effectiveOn: effectiveOn || null,
                  ...referenceInput(reference, uploadId),
                }),
            ),
          'Draft version created.',
        );
      }}
    >
      <h3 className="text-sm font-semibold text-slate-900 sm:col-span-3">New draft version</h3>
      <Field label="Version label">
        <input
          className={inputClass}
          required
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.currentTarget.value)}
        />
      </Field>
      <Field label="Version effective on">
        <input
          className={inputClass}
          type="date"
          value={effectiveOn}
          onChange={(e) => setEffectiveOn(e.currentTarget.value)}
        />
      </Field>
      <ReferenceFields form={reference} onChange={update} uploads={uploads} uploader={uploader} />
      <div className="sm:col-span-3">
        <Field label="Acknowledgement statement">
          <textarea
            className={inputClass}
            rows={2}
            required={policy.acknowledgementRequired}
            value={statement}
            onChange={(e) => setStatement(e.currentTarget.value)}
          />
        </Field>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          {problem}
        </p>
      )}
      <div className="sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy || uploader.uploading}>
          {uploader.uploading ? 'Uploading…' : 'Create draft version'}
        </button>
      </div>
    </form>
  );
}

/**
 * Batch 9 (D10): a retired policy is never un-retired; its title, description, type,
 * acknowledgement setting and audience are copied into a new draft policy (without versions).
 */
function CopyPolicyForm({
  policy,
  busy,
  mutate,
  onDone,
}: {
  policy: Policy;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [code, setCode] = useState('');
  const [title, setTitle] = useState(policy.title);
  return (
    <form
      aria-label={`Copy ${policy.title}`}
      className="grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate(
          () =>
            documentsApi.copyPolicy(policy.id, {
              code: code.trim(),
              ...(title.trim() && title.trim() !== policy.title ? { title: title.trim() } : {}),
            }),
          (result) =>
            `Copied into the draft policy ${(result as Policy).code}. Add a version and publish it when ready.`,
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <h3 className="text-sm font-semibold text-slate-900 sm:col-span-3">
        Copy into a new draft policy
      </h3>
      <Field label="New policy code">
        <input
          className={inputClass}
          required
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
      </Field>
      <Field label="New policy title">
        <input
          className={inputClass}
          required
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
      </Field>
      <p className="text-xs text-slate-600 sm:col-span-3">
        The retired policy, its versions and its acknowledgements are not changed. Employees
        acknowledge the new policy once a version of it is published.
      </p>
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy || !code.trim()}>
          Create draft copy
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const TRACKING_LABELS: Record<PolicyTracking['items'][number]['status'], string> = {
  ACKNOWLEDGED: 'Acknowledged',
  EARLIER_VERSION_ONLY: 'Earlier version only',
  PENDING: 'Pending',
};

function TrackingSection({ policyId, version }: { policyId: string; version: number }) {
  const [state, setState] = useState<{
    data: PolicyTracking | null;
    error: string | null;
    loaded: boolean;
  }>({ data: null, error: null, loaded: false });
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      documentsApi
        .policyTracking(policyId)
        .then((data) => {
          if (active) setState({ data, error: null, loaded: true });
        })
        .catch((cause) => {
          if (active)
            setState({
              data: null,
              error: documentsErrorMessage(cause, 'Unable to load acknowledgements.'),
              loaded: true,
            });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [policyId, version]);
  const { data } = state;
  return (
    <section aria-label="Acknowledgement tracking" className="space-y-2">
      <h3 className="text-sm font-semibold uppercase text-slate-500">Acknowledgements</h3>
      {!state.loaded ? (
        <Loading />
      ) : state.error ? (
        <p className="text-sm text-slate-600">{state.error}</p>
      ) : !data || !data.currentVersionId ? (
        <EmptyState>Publish a version to track acknowledgements.</EmptyState>
      ) : (
        <>
          <p className="text-sm text-slate-800">
            {data.counts.acknowledged} of {data.counts.audience} acknowledged the current version ·{' '}
            {data.counts.pending} pending
          </p>
          {data.items.length > 0 && (
            <DataTable
              label="Acknowledgements"
              rows={data.items}
              rowKey={(item) => item.employee.id}
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  rowHeader: true,
                  cell: (item) => (
                    <>
                      {item.employee.displayName ?? '—'}
                      <span className="block text-xs font-normal text-slate-500">
                        {item.employee.employeeNumber}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (item) => <>{TRACKING_LABELS[item.status]}</>,
                },
                {
                  key: 'acknowledged',
                  header: 'Acknowledged',
                  cell: (item) => <>{dateTimeText(item.acknowledgedAt)}</>,
                },
              ]}
            />
          )}
        </>
      )}
    </section>
  );
}
