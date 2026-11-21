'use client';

import { LoadingState } from '../ui/states';
import { PageContainer } from '../ui/page-container';
import { PageHeader } from '../ui/page-header';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { hasPermission } from '../../lib/authorization/can';
import { documentsApi } from '../../lib/documents/api';
import {
  documentsErrorMessage,
  isDocumentsForbidden,
  isDocumentsNotFound,
} from '../../lib/documents/errors';
import type { Confidentiality, EmployeeDocument } from '../../lib/documents/types';
import { useAuth } from '../../providers/auth-provider';
import {
  AddVersionForm,
  ArchivedBadge,
  CONFIDENTIALITY_LABELS,
  CONFIDENTIALITY_LEVELS,
  ConfidentialityBadge,
  dateTimeText,
  ExpiryBadge,
  Field,
  formatDateOnly,
  inputClass,
  primaryButton,
  ReferenceText,
  type Run,
  secondaryButton,
  Section,
  SOURCE_LABELS,
} from './documents-shared';
import { DataTable } from '../ui/data-table';

/**
 * One employee document as the viewer may see it: its details, every version (earlier versions
 * are kept and marked superseded) and, for document.manage holders with clearance, new
 * versions, edits / re-classification and archiving with a reason.
 */
export function DocumentRecordPage({ documentId }: { documentId: string }) {
  const { authorization } = useAuth();
  const [document, setDocument] = useState<EmployeeDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'version' | 'edit' | 'archive' | null>(null);

  const load = useCallback(async () => {
    try {
      setDocument(await documentsApi.document(documentId));
      setError(null);
    } catch (cause) {
      setForbidden(isDocumentsForbidden(cause));
      setNotFound(isDocumentsNotFound(cause));
      setError(documentsErrorMessage(cause, 'Unable to load the document.'));
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run: Run = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = (await action()) as EmployeeDocument | undefined;
      if (result && typeof result === 'object' && 'versions' in result) setDocument(result);
      else await load();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(documentsErrorMessage(cause, 'Unable to update the document.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const back =
    hasPermission(authorization, 'employee.read') && document
      ? { href: `/admin/employees/${document.employeeId}`, text: '← Employee record' }
      : { href: '/documents', text: '← My documents' };

  if (loading) {
    return (
      <PageContainer>
        <LoadingState label="Loading document…" />
      </PageContainer>
    );
  }
  if (forbidden) {
    // Batch 10E-2: the denied state in the page's own width.
    return (
      <PageContainer padded={false}>
        <Forbidden message="You do not have access to this document." />
      </PageContainer>
    );
  }
  if (!document) {
    return (
      <PageContainer>
        <Link href="/documents" className="text-sm font-medium text-indigo-700 hover:underline">
          ← My documents
        </Link>
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">
            {notFound ? 'Document not found' : 'Unable to load document'}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {notFound
              ? 'This document may not exist or may not be available to you.'
              : (error ?? 'Unable to load the document.')}
          </p>
        </div>
      </PageContainer>
    );
  }

  const current = document.currentVersion;
  const canManage = document.actions.canManage;
  return (
    <PageContainer className="space-y-6">
      <Link href={back.href} className="text-sm font-medium text-indigo-700 hover:underline">
        {back.text}
      </Link>
      <div className="space-y-2">
        <PageHeader eyebrow={document.type.name} title={document.title}>
          <ConfidentialityBadge level={document.confidentiality} />
          <ExpiryBadge status={document.expiryStatus} />
          {document.status === 'ARCHIVED' && <ArchivedBadge />}
        </PageHeader>
        <p className="text-sm text-slate-600">
          {SOURCE_LABELS[document.source]} · Added {dateTimeText(document.createdAt)}
          {document.archivedAt ? ` · Archived ${dateTimeText(document.archivedAt)}` : ''}
        </p>
        {document.provenance && (
          <p className="text-xs text-slate-500">
            Moved from recruitment when the candidate was hired.
          </p>
        )}
        {document.description && (
          <p className="whitespace-pre-line text-sm text-slate-700">{document.description}</p>
        )}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}

      <Section title="Current version">
        {current ? (
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <Detail term="Version">{current.versionNumber}</Detail>
            <Detail term="Issued">{formatDateOnly(current.issuedOn)}</Detail>
            <Detail term="Effective">{formatDateOnly(current.effectiveOn)}</Detail>
            <Detail term="Expires">{formatDateOnly(current.expiresOn)}</Detail>
            <Detail term="Reference">
              <ReferenceText
                reference={current}
                text={`Open ${document.title}`}
                name={`${document.title}, version ${current.versionNumber}`}
                getLink={() => documentsApi.versionDownload(document.id, current.id)}
              />
            </Detail>
            <Detail term="Note">{current.note ?? '—'}</Detail>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">No current version.</p>
        )}
      </Section>

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setPanel(panel === 'version' ? null : 'version')}
          >
            Add version
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setPanel(panel === 'edit' ? null : 'edit')}
          >
            Edit or reclassify
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setPanel(panel === 'archive' ? null : 'archive')}
          >
            Archive
          </button>
        </div>
      )}
      {canManage && panel === 'version' && (
        <AddVersionForm
          name={document.title}
          expiryRequired={document.type.expiryTracked}
          busy={busy}
          run={run}
          target={{ kind: 'version', documentId: document.id }}
          onSubmit={(input) => documentsApi.addVersion(document.id, input)}
          onDone={() => setPanel(null)}
        />
      )}
      {canManage && panel === 'edit' && (
        <EditForm document={document} busy={busy} run={run} onDone={() => setPanel(null)} />
      )}
      {canManage && panel === 'archive' && (
        <ArchiveForm document={document} busy={busy} run={run} onDone={() => setPanel(null)} />
      )}

      <Section title="Version history">
        <p className="text-xs text-slate-600">
          Every version is kept. A new version supersedes the previous one; nothing is overwritten.
        </p>
        <DataTable
          label="Versions"
          minWidth="min-w-[760px]"
          rows={document.versions}
          rowKey={(version) => version.id}
          rowLabel={(version) => `Version ${version.versionNumber}`}
          columns={[
            {
              key: 'version',
              header: 'Version',
              rowHeader: true,
              cell: (version) => <>{version.versionNumber}</>,
            },
            {
              key: 'reference',
              header: 'Reference',
              cell: (version) => (
                <>
                  <ReferenceText
                    reference={version}
                    text={`Open version ${version.versionNumber}`}
                    name={`${document.title}, version ${version.versionNumber}`}
                    getLink={() => documentsApi.versionDownload(document.id, version.id)}
                  />
                  {version.note && (
                    <span className="block text-xs text-slate-500">{version.note}</span>
                  )}
                </>
              ),
            },
            {
              key: 'issued',
              header: 'Issued',
              cell: (version) => <>{formatDateOnly(version.issuedOn)}</>,
            },
            {
              key: 'expires',
              header: 'Expires',
              cell: (version) => (
                <>
                  {formatDateOnly(version.expiresOn)}
                  {version.current && version.expiresOn && (
                    <span className="block">
                      <ExpiryBadge status={version.expiryStatus} />
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (version) => (
                <>
                  {version.current ? (
                    <span className="font-medium text-emerald-800">Current</span>
                  ) : (
                    <span className="text-slate-600">
                      Superseded {dateTimeText(version.supersededAt)}
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'added',
              header: 'Added',
              cell: (version) => <>{dateTimeText(version.createdAt)}</>,
            },
          ]}
        />
      </Section>
    </PageContainer>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{term}</dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}

function EditForm({
  document,
  busy,
  run,
  onDone,
}: {
  document: EmployeeDocument;
  busy: boolean;
  run: Run;
  onDone(): void;
}) {
  const [title, setTitle] = useState(document.title);
  const [description, setDescription] = useState(document.description ?? '');
  const [confidentiality, setConfidentiality] = useState<Confidentiality>(document.confidentiality);
  return (
    <form
      aria-label="Edit document"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () =>
            documentsApi.updateDocument(document.id, {
              title: title.trim(),
              description: description.trim() || null,
              ...(confidentiality !== document.confidentiality ? { confidentiality } : {}),
            }),
          confidentiality !== document.confidentiality
            ? 'Document reclassified.'
            : 'Document saved.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
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
          onChange={(e) => setConfidentiality(e.currentTarget.value as Confidentiality)}
        >
          {CONFIDENTIALITY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {CONFIDENTIALITY_LABELS[level]}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description">
          <textarea
            className={inputClass}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </Field>
      </div>
      <p className="text-xs text-slate-600 sm:col-span-2">
        Reclassifying needs read clearance for both the current and the new level, and is audited.
      </p>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          Save changes
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ArchiveForm({
  document,
  busy,
  run,
  onDone,
}: {
  document: EmployeeDocument;
  busy: boolean;
  run: Run;
  onDone(): void;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      aria-label="Archive document"
      className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) return;
        void run(
          () => documentsApi.archiveDocument(document.id, reason.trim()),
          'Document archived.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <Field label="Reason for archiving">
        <input
          className={inputClass}
          required
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
      </Field>
      <button type="submit" className={primaryButton} disabled={busy || !reason.trim()}>
        Archive document
      </button>
      <button type="button" className={secondaryButton} onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}
