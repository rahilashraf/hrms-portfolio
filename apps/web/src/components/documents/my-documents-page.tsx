'use client';

import { checkboxClass } from '../ui/tokens';
import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { documentsApi } from '../../lib/documents/api';
import { documentsErrorCode, documentsErrorMessage } from '../../lib/documents/errors';
import type {
  DocumentType,
  EmployeeDocument,
  MyDocuments,
  MyPolicy,
} from '../../lib/documents/types';
import {
  AddVersionForm,
  dateTimeText,
  EmptyState,
  ExpiryBadge,
  Field,
  formatDateOnly,
  inputClass,
  primaryButton,
  ReferenceText,
  referenceProblem,
  saveWithUpload,
  useVersionForm,
  RequirementBadge,
  type Run,
  secondaryButton,
  Section,
  VersionFields,
  versionInput,
} from './documents-shared';

/**
 * Self-service "My documents": the signed-in employee's own employee-visible records (with
 * their expiry), the required documents they are missing, documents they can provide
 * themselves, and the policies addressed to them with per-version acknowledgement.
 */
export function MyDocumentsPage() {
  const [records, setRecords] = useState<MyDocuments[]>([]);
  const [policies, setPolicies] = useState<MyPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const [mine, myPolicies] = await Promise.all([
        documentsApi.mine(),
        documentsApi.myPolicies(),
      ]);
      setRecords(mine.items);
      setPolicies(myPolicies.items);
      setError(null);
    } catch (cause) {
      setError(documentsErrorMessage(cause, 'Unable to load your documents.'));
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (documentsErrorCode(cause) === 'POLICY_VERSION_NOT_CURRENT') await load();
      setError(documentsErrorMessage(cause, 'Unable to save the document.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My documents"
        description="Your employee records, the documents you still need to provide, and the policies you are asked to acknowledge."
      />
      <div className="mt-8 space-y-6">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading documents…
          </p>
        ) : (
          <>
            {records.length === 0 ? (
              <EmptyState>You have no employee records.</EmptyState>
            ) : (
              records.map((item) => (
                <OrganizationRecords
                  key={`${item.organization.id}-${version}`}
                  item={item}
                  busy={busy}
                  run={run}
                />
              ))
            )}
            <Section title="My policies">
              {policies.length === 0 ? (
                <EmptyState>No policies are addressed to you.</EmptyState>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {policies.map((policy) => (
                    <PolicyItem
                      key={`${policy.id}-${version}`}
                      policy={policy}
                      busy={busy}
                      run={run}
                    />
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </PageContainer>
  );
}

function OrganizationRecords({ item, busy, run }: { item: MyDocuments; busy: boolean; run: Run }) {
  const [providing, setProviding] = useState<string | null>(null);
  return (
    <Section title={`Records — ${item.organization.name}`}>
      {item.missing.length > 0 && (
        <div
          role="region"
          aria-label={`Missing documents — ${item.organization.name}`}
          className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
        >
          <h3 className="text-sm font-semibold text-amber-900">Required documents missing</h3>
          <ul className="space-y-1 text-sm">
            {item.missing.map((missing) => (
              <li key={missing.typeId} className="flex flex-wrap items-center gap-2">
                <span className="text-slate-900">{missing.typeName}</span>
                <RequirementBadge status={missing.status} />
                {missing.employeeProvided &&
                  item.providableTypes.some((t) => t.id === missing.typeId) && (
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={`Provide ${missing.typeName}`}
                      onClick={() => setProviding(missing.typeId)}
                    >
                      Provide
                    </button>
                  )}
                {!missing.employeeProvided && (
                  <span className="text-xs text-slate-600">HR records this document.</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.documents.length === 0 ? (
        <EmptyState>No documents yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {item.documents.map((document) => (
            <MyDocumentItem key={document.id} document={document} busy={busy} run={run} />
          ))}
        </ul>
      )}
      {item.providableTypes.length > 0 &&
        (providing ? (
          <ProvideForm
            key={providing}
            organizationId={item.organization.id}
            types={item.providableTypes}
            initialTypeId={providing}
            busy={busy}
            run={run}
            onDone={() => setProviding(null)}
          />
        ) : (
          <button
            type="button"
            className={primaryButton}
            onClick={() => setProviding(item.providableTypes[0]!.id)}
          >
            Provide a document
          </button>
        ))}
    </Section>
  );
}

function MyDocumentItem({
  document,
  busy,
  run,
}: {
  document: EmployeeDocument;
  busy: boolean;
  run: Run;
}) {
  const [adding, setAdding] = useState(false);
  const current = document.currentVersion;
  return (
    <li aria-label={`Document ${document.title}`} className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{document.title}</h3>
        <ExpiryBadge status={document.expiryStatus} />
      </div>
      <p className="text-xs text-slate-500">
        {document.type.name}
        {current ? ` · Version ${current.versionNumber}` : ''}
        {current?.expiresOn ? ` · Expires ${formatDateOnly(current.expiresOn)}` : ''}
        {document.versions.length > 1 ? ` · ${document.versions.length} versions kept` : ''}
      </p>
      {current && (
        <ReferenceText
          reference={current}
          text={`Open ${document.title}`}
          name={document.title}
          getLink={() => documentsApi.versionDownload(document.id, current.id)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          className="text-sm text-indigo-700 underline"
          href={`/documents/records/${document.id}`}
        >
          Version history
        </Link>
        {document.actions.canAddVersion && !adding && (
          <button
            type="button"
            className={secondaryButton}
            aria-label={`Add a new version of ${document.title}`}
            onClick={() => setAdding(true)}
          >
            Add new version
          </button>
        )}
      </div>
      {adding && (
        <AddVersionForm
          name={document.title}
          expiryRequired={document.type.expiryTracked}
          busy={busy}
          run={run}
          target={{ kind: 'version', documentId: document.id }}
          onSubmit={(input) => documentsApi.addVersion(document.id, input)}
          onDone={() => setAdding(false)}
        />
      )}
    </li>
  );
}

function ProvideForm({
  organizationId,
  types,
  initialTypeId,
  busy,
  run,
  onDone,
}: {
  organizationId: string;
  types: DocumentType[];
  initialTypeId: string;
  busy: boolean;
  run: Run;
  onDone(): void;
}) {
  const [typeId, setTypeId] = useState(initialTypeId);
  const initial = types.find((t) => t.id === initialTypeId);
  const [title, setTitle] = useState(initial?.name ?? '');
  const { form, update, uploads, uploader } = useVersionForm();
  const [problem, setProblem] = useState<string | null>(null);
  const type = types.find((t) => t.id === typeId);
  const expiryRequired = Boolean(type?.expiryTracked);
  return (
    <form
      aria-label="Provide a document"
      className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const found = referenceProblem(form, expiryRequired, uploads);
        setProblem(found);
        if (found) return;
        void run(
          () =>
            saveWithUpload(form, update, { kind: 'self', organizationId }, uploader, (uploadId) =>
              documentsApi.provide({
                organizationId,
                typeId,
                title: title.trim(),
                version: versionInput(form, uploadId),
              }),
            ),
          'Document provided.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <h3 className="text-sm font-semibold text-slate-900 sm:col-span-3">Provide a document</h3>
      <p className="text-xs text-slate-600 sm:col-span-3">
        {uploads?.enabled
          ? 'Upload the file (PDF, PNG or JPEG), or add a link to where it is kept. HR can see what you provide; it is visible to you too.'
          : 'Add a reference to where the document is kept (for example a Google Drive link).'}
      </p>
      <Field label="Document type">
        <select
          className={inputClass}
          value={typeId}
          onChange={(e) => {
            const next = e.currentTarget.value;
            const previous = types.find((t) => t.id === typeId);
            if (!title.trim() || title === previous?.name) {
              setTitle(types.find((t) => t.id === next)?.name ?? '');
            }
            setTypeId(next);
          }}
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input
          className={inputClass}
          required
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
      </Field>
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
        <button type="submit" className={primaryButton} disabled={busy || uploader.uploading}>
          {uploader.uploading ? 'Uploading…' : 'Save document'}
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

function PolicyItem({ policy, busy, run }: { policy: MyPolicy; busy: boolean; run: Run }) {
  const [accepted, setAccepted] = useState(false);
  const current = policy.currentVersion;
  const statement =
    current?.acknowledgementStatement ??
    (current ? `I have received version ${current.versionLabel} of ${policy.title}.` : '');
  return (
    <li aria-label={`Policy ${policy.title}`} className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{policy.title}</h3>
        {current && (
          <span className="text-xs text-slate-500">
            Version {current.versionLabel}
            {current.effectiveOn ? ` · effective ${formatDateOnly(current.effectiveOn)}` : ''}
          </span>
        )}
      </div>
      {policy.description && (
        <p className="whitespace-pre-line text-sm text-slate-700">{policy.description}</p>
      )}
      {current && (
        <ReferenceText
          reference={current}
          text={`Read ${policy.title}`}
          name={`${policy.title} ${current.versionLabel}`}
          getLink={() => documentsApi.policyVersionDownload(policy.id, current.id)}
        />
      )}
      {policy.myAcknowledgement && current && (
        <p className="text-sm text-emerald-800">
          You acknowledged version {current.versionLabel} on{' '}
          {dateTimeText(policy.myAcknowledgement.acknowledgedAt)}.
        </p>
      )}
      {!policy.acknowledgementRequired && !policy.myAcknowledgement && (
        <p className="text-xs text-slate-500">No acknowledgement is required.</p>
      )}
      {policy.needsAcknowledgement && current && (
        <form
          aria-label={`Acknowledge ${policy.title}`}
          className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!accepted) return;
            void run(
              () => documentsApi.acknowledgePolicy(policy.id, current.id),
              'Acknowledgement recorded.',
            );
          }}
        >
          <p className="text-xs font-semibold uppercase text-indigo-800">
            Acknowledge version {current.versionLabel}
          </p>
          {policy.acknowledgedEarlierVersion && (
            <p className="text-xs text-slate-700">
              You acknowledged an earlier version. This version needs a new acknowledgement.
            </p>
          )}
          <blockquote className="whitespace-pre-line text-sm text-slate-900">
            {statement}
          </blockquote>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              required
              checked={accepted}
              onChange={(e) => setAccepted(e.currentTarget.checked)}
              className={checkboxClass}
            />
            I acknowledge the statement above.
          </label>
          <button type="submit" className={primaryButton} disabled={busy || !accepted}>
            Acknowledge
          </button>
        </form>
      )}
    </li>
  );
}
