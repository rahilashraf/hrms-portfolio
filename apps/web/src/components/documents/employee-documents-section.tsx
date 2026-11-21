'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { documentsApi } from '../../lib/documents/api';
import { employeeApi } from '../../lib/employee/api';
import type { EmployeeAssignmentView } from '../../lib/employee/types';
import {
  documentsErrorMessage,
  isDocumentsForbidden,
  isDocumentsNotFound,
} from '../../lib/documents/errors';
import type { Confidentiality, DocumentType, EmployeeRecords } from '../../lib/documents/types';
import {
  ArchivedBadge,
  CONFIDENTIALITY_LABELS,
  CONFIDENTIALITY_LEVELS,
  ConfidentialityBadge,
  dateTimeText,
  EmptyState,
  ExpiryBadge,
  Field,
  formatDateOnly,
  inputClass,
  primaryButton,
  referenceProblem,
  DownloadButton,
  saveWithUpload,
  useVersionForm,
  RequirementBadge,
  type Run,
  secondaryButton,
  VersionFields,
  versionInput,
} from './documents-shared';
import { DataTable } from '../ui/data-table';

/**
 * The employee profile's documents section, for document.* holders only (never implied by
 * employee access). The API returns only organizations and confidentiality levels the viewer
 * reaches; when it refuses (403 / 404) the section is hidden.
 */
export function EmployeeDocumentsSection({ employeeId }: { employeeId: string }) {
  const [items, setItems] = useState<EmployeeRecords[]>([]);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await documentsApi.employeeRecords(employeeId);
      setItems(result.items);
      setError(null);
    } catch (cause) {
      if (isDocumentsForbidden(cause) || isDocumentsNotFound(cause)) setHidden(true);
      else setError(documentsErrorMessage(cause, 'Unable to load the employee’s documents.'));
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

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
      setVersion((v) => v + 1);
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(documentsErrorMessage(cause, 'Unable to save the document.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;
  return (
    <section aria-labelledby="documents-heading" className="mt-8 space-y-4">
      <h2 id="documents-heading" className="text-xl font-semibold text-slate-950">
        Documents
      </h2>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      {loading ? (
        <p role="status" className="text-sm text-slate-600">
          Loading documents…
        </p>
      ) : items.length === 0 ? (
        error ? null : (
          <EmptyState>No document records you can access.</EmptyState>
        )
      ) : (
        items.map((item) => (
          <OrganizationRecords
            key={`${item.organization.id}-${version}`}
            employeeId={employeeId}
            item={item}
            multiple={items.length > 1}
            busy={busy}
            run={run}
          />
        ))
      )}
    </section>
  );
}

function OrganizationRecords({
  employeeId,
  item,
  multiple,
  busy,
  run,
}: {
  employeeId: string;
  item: EmployeeRecords;
  multiple: boolean;
  busy: boolean;
  run: Run;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div
      role="region"
      aria-label={`Documents — ${item.organization.name}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      {multiple && (
        <h3 className="text-base font-semibold text-slate-900">{item.organization.name}</h3>
      )}
      {item.requirements.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-slate-800">Required documents</h4>
          <ul className="flex flex-wrap gap-3 text-sm">
            {item.requirements.map((requirement) => (
              <li key={requirement.typeId} className="flex items-center gap-1">
                {requirement.typeName} <RequirementBadge status={requirement.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.documents.length === 0 ? (
        <EmptyState>No documents.</EmptyState>
      ) : (
        <DataTable
          label={`Documents of ${item.organization.name}`}
          minWidth="min-w-[760px]"
          rows={item.documents}
          rowKey={(document) => document.id}
          columns={[
            {
              key: 'document',
              header: 'Document',
              rowHeader: true,
              cell: (document) => (
                <>
                  {document.title}
                  <span className="block text-xs font-normal text-slate-500">
                    {document.type.name}
                  </span>
                </>
              ),
            },
            {
              key: 'confidentiality',
              header: 'Confidentiality',
              cell: (document) => (
                <>
                  <ConfidentialityBadge level={document.confidentiality} />
                </>
              ),
            },
            {
              key: 'current',
              header: 'Current version',
              cell: (document) => (
                <>
                  {document.currentVersion
                    ? `Version ${document.currentVersion.versionNumber}`
                    : '—'}
                  {document.versions.length > 1 && (
                    <span className="block text-xs text-slate-500">
                      {document.versions.length} versions
                    </span>
                  )}
                  {document.currentVersion?.file && (
                    <span className="mt-1 block">
                      <DownloadButton
                        file={document.currentVersion.file}
                        name={document.title}
                        getLink={() =>
                          documentsApi.versionDownload(document.id, document.currentVersion!.id)
                        }
                      />
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'expiry',
              header: 'Expiry',
              cell: (document) => (
                <>
                  {document.status === 'ARCHIVED' ? (
                    <ArchivedBadge />
                  ) : (
                    <>
                      <ExpiryBadge status={document.expiryStatus} />
                      {document.currentVersion?.expiresOn && (
                        <span className="block text-xs text-slate-500">
                          {formatDateOnly(document.currentVersion.expiresOn)}
                        </span>
                      )}
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (document) => (
                <>
                  <Link
                    className="text-indigo-700 underline"
                    href={`/documents/records/${document.id}`}
                    aria-label={`Open ${document.title}`}
                  >
                    Open
                  </Link>
                </>
              ),
            },
          ]}
        />
      )}
      {item.acknowledgements.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-slate-800">Policy acknowledgements</h4>
          <ul className="space-y-1 text-sm text-slate-700">
            {item.acknowledgements.map((ack) => (
              <li key={ack.id}>
                {ack.policy.title} — version {ack.versionLabel}
                {ack.current ? ' (current)' : ' (earlier version)'} · acknowledged{' '}
                {dateTimeText(ack.acknowledgedAt)}
                {ack.source === 'ONBOARDING_TASK' ? ' during onboarding' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.access.canManage &&
        (creating ? (
          <CreateRecordForm
            employeeId={employeeId}
            organizationId={item.organization.id}
            busy={busy}
            run={run}
            onDone={() => setCreating(false)}
          />
        ) : (
          <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
            Add document record
          </button>
        ))}
    </div>
  );
}

function CreateRecordForm({
  employeeId,
  organizationId,
  busy,
  run,
  onDone,
}: {
  employeeId: string;
  organizationId: string;
  busy: boolean;
  run: Run;
  onDone(): void;
}) {
  const [types, setTypes] = useState<DocumentType[] | null>(null);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [confidentiality, setConfidentiality] = useState<Confidentiality | ''>('');
  const { form, update, uploads, uploader } = useVersionForm();
  const [problem, setProblem] = useState<string | null>(null);
  // Batch 5C: optionally link the record to one of the employee's assignments in this
  // organization (the API checks it belongs to the employee and the organization).
  const [assignmentId, setAssignmentId] = useState('');
  const [assignments, setAssignments] = useState<EmployeeAssignmentView[] | null>(null);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      employeeApi
        .get(employeeId)
        .then((profile) => {
          if (!active) return;
          setAssignments(
            [
              ...profile.assignments.current,
              ...profile.assignments.upcoming,
              ...profile.assignments.historical,
            ].filter((assignment) => assignment.organization.id === organizationId),
          );
        })
        .catch(() => {
          // Without the employee's assignments the record is linked to the employee only.
          if (active) setAssignments([]);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [employeeId, organizationId]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      documentsApi
        .types(organizationId)
        .then((result) => {
          if (!active) return;
          setTypes(result.items);
          setTypeId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => {
          if (active) setTypesError(documentsErrorMessage(cause, 'Unable to load document types.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId]);

  const type = types?.find((t) => t.id === typeId);
  const expiryRequired = Boolean(type?.expiryTracked);
  return (
    <form
      aria-label="Add document record"
      className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!typeId) return;
        const found = referenceProblem(form, expiryRequired, uploads);
        setProblem(found);
        if (found) return;
        void run(
          () =>
            saveWithUpload(
              form,
              update,
              { kind: 'record', organizationId, employeeId },
              uploader,
              (uploadId) =>
                documentsApi.createDocument({
                  organizationId,
                  employeeId,
                  typeId,
                  employmentAssignmentId: assignmentId || null,
                  title: title.trim(),
                  description: description.trim() || null,
                  confidentiality: confidentiality || null,
                  version: versionInput(form, uploadId),
                }),
            ),
          'Document record added.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <h4 className="text-sm font-semibold text-slate-900 sm:col-span-3">Add document record</h4>
      {typesError && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          {typesError}
        </p>
      )}
      {types && types.length === 0 && (
        <p className="text-sm text-slate-600 sm:col-span-3">
          The organization has no document types yet. Initialize the defaults in Documents
          administration.
        </p>
      )}
      <Field label="Document type">
        <select
          className={inputClass}
          required
          value={typeId}
          onChange={(e) => setTypeId(e.currentTarget.value)}
        >
          {(types ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      {assignments && assignments.length > 0 && (
        <Field label="Assignment (optional)">
          <select
            className={inputClass}
            value={assignmentId}
            onChange={(e) => setAssignmentId(e.currentTarget.value)}
          >
            <option value="">The employee (no specific assignment)</option>
            {assignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {assignment.position.name}
                {assignment.status === 'ENDED'
                  ? ' (ended)'
                  : assignment.status === 'PLANNED'
                    ? ' (planned)'
                    : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Title">
        <input
          className={inputClass}
          required
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
      </Field>
      <Field label="Confidentiality">
        <select
          className={inputClass}
          value={confidentiality}
          onChange={(e) => setConfidentiality(e.currentTarget.value as Confidentiality | '')}
        >
          <option value="">
            Type default
            {type ? ` (${CONFIDENTIALITY_LABELS[type.defaultConfidentiality]})` : ''}
          </option>
          {CONFIDENTIALITY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {CONFIDENTIALITY_LABELS[level]}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-3">
        <Field label="Description">
          <textarea
            className={inputClass}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </Field>
      </div>
      <VersionFields
        form={form}
        expiryRequired={expiryRequired}
        uploads={uploads}
        uploader={uploader}
        onChange={update}
      />
      {problem && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || !typeId || uploader.uploading}
        >
          {uploader.uploading ? 'Uploading…' : 'Save record'}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            uploader.cancel();
            onDone();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
