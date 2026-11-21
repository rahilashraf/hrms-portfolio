'use client';

import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import {
  documentsApi,
  startDownload,
  type UploadTarget,
  type VersionInput,
} from '../../lib/documents/api';
import { documentsErrorCode, documentsErrorMessage } from '../../lib/documents/errors';
import type {
  Confidentiality,
  DocumentCategory,
  DocumentSource,
  EmploymentType,
  ExpiryStatus,
  PolicyStatus,
  PolicyVersionState,
  RequirementStatus,
  DownloadLink,
  ScanStatus,
  StorageProvider,
  StorageReference,
  StoredFile,
  UploadCapability,
  UploadedFile,
} from '../../lib/documents/types';
import {
  Field,
  inputClass,
  isHttpsUrl,
  label,
  primaryButton,
  SafeLink,
  secondaryButton,
} from '../onboarding/onboarding-shared';

export {
  dateTimeText,
  EmptyState,
  Field,
  formatDateOnly,
  inputClass,
  isHttpsUrl,
  label,
  primaryButton,
  SafeLink,
  secondaryButton,
  Section,
} from '../onboarding/onboarding-shared';

export type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

/** Any of these shows the Documents administration (the API decides what is reachable). */
export const DOCUMENT_PERMISSION_KEYS = [
  'document.read',
  'document.confidential.read',
  'document.restricted.read',
  'document.manage',
  'document.type.manage',
  'document.policy.manage',
] as const;

/** Reading an employee's records takes a document read or manage permission. */
export const DOCUMENT_RECORD_KEYS = [
  'document.read',
  'document.confidential.read',
  'document.restricted.read',
  'document.manage',
] as const;

const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';

export const CATEGORIES: DocumentCategory[] = [
  'EMPLOYMENT_AGREEMENT',
  'OFFER_LETTER',
  'RESUME',
  'CERTIFICATION',
  'LICENSE',
  'BACKGROUND_CHECK',
  'HANDBOOK',
  'POLICY',
  'EVALUATION',
  'PAYROLL',
  'TAX',
  'IDENTIFICATION',
  'TRAINING_CERTIFICATE',
  'OTHER',
];

export const CONFIDENTIALITY_LABELS: Record<Confidentiality, string> = {
  EMPLOYEE_VISIBLE: 'Employee visible',
  MANAGER_VISIBLE: 'Manager visible',
  HR_ONLY: 'HR only',
  RESTRICTED: 'Restricted',
};

export const CONFIDENTIALITY_LEVELS = Object.keys(CONFIDENTIALITY_LABELS) as Confidentiality[];

export const PROVIDER_LABELS: Record<StorageProvider, string> = {
  GOOGLE_DRIVE: 'Google Drive',
  EXTERNAL_URL: 'External link',
  INTERNAL_OBJECT_STORAGE: 'Uploaded file',
  MANUAL_REFERENCE: 'Manual reference (paper / offline)',
};

export const PROVIDERS = Object.keys(PROVIDER_LABELS) as StorageProvider[];

export const EMPLOYMENT_TYPES: EmploymentType[] = ['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT'];

export const SOURCE_LABELS: Record<DocumentSource, string> = {
  HR: 'Recorded by HR',
  EMPLOYEE: 'Provided by the employee',
  ONBOARDING: 'Provided during onboarding',
  RECRUITMENT_HANDOFF: 'Moved from recruitment',
};

// Batch 10E-2: document statuses use `StatusBadge` (words always shown); confidentiality is a
// classification, not a status, and keeps its own colours.
const EXPIRY_TONES: Record<ExpiryStatus, Tone> = {
  NO_EXPIRY: 'neutral',
  VALID: 'success',
  EXPIRING_SOON: 'warning',
  EXPIRED: 'danger',
};

const EXPIRY_LABELS: Record<ExpiryStatus, string> = {
  NO_EXPIRY: 'No expiry',
  VALID: 'Valid',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Expired',
};

export function ExpiryBadge({ status }: { status: ExpiryStatus }) {
  return <StatusBadge status={status} label={EXPIRY_LABELS[status]} tone={EXPIRY_TONES[status]} />;
}

const CONFIDENTIALITY_STYLES: Record<Confidentiality, string> = {
  EMPLOYEE_VISIBLE: 'bg-sky-50 text-sky-800',
  MANAGER_VISIBLE: 'bg-indigo-50 text-indigo-800',
  HR_ONLY: 'bg-violet-50 text-violet-800',
  RESTRICTED: 'bg-rose-50 text-rose-800',
};

export function ConfidentialityBadge({ level }: { level: Confidentiality }) {
  return (
    <span className={`${badge} ${CONFIDENTIALITY_STYLES[level]}`}>
      {CONFIDENTIALITY_LABELS[level]}
    </span>
  );
}

const REQUIREMENT_TONES: Record<RequirementStatus, Tone> = {
  SATISFIED: 'success',
  MISSING: 'warning',
  EXPIRED: 'danger',
};

export function RequirementBadge({ status }: { status: RequirementStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={REQUIREMENT_TONES[status]} />;
}

const POLICY_TONES: Record<PolicyStatus, Tone> = {
  DRAFT: 'neutral',
  PUBLISHED: 'success',
  RETIRED: 'neutral',
};

export function PolicyStatusBadge({ status }: { status: PolicyStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={POLICY_TONES[status]} />;
}

const VERSION_TONES: Record<PolicyVersionState, Tone> = {
  DRAFT: 'neutral',
  CURRENT: 'success',
  SUPERSEDED: 'neutral',
};

export function VersionStateBadge({ state }: { state: PolicyVersionState }) {
  return <StatusBadge status={state} label={label(state)} tone={VERSION_TONES[state]} />;
}

export function ArchivedBadge() {
  return <StatusBadge status="ARCHIVED" label="Archived" tone="neutral" />;
}

// ─── Batch 9: files ─────────────────────────────────────────────────────────

/** Kinds the API accepts (checked again by content on the server). */
export const ALLOWED_FILE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'] as const;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const TYPE_NAMES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

export function fileTypeName(mimeType: string | null | undefined): string {
  return (mimeType && TYPE_NAMES[mimeType]) || 'File';
}

/** A client-side check (the server checks again by content), or null when the file may be sent. */
export function fileProblem(file: File, uploads: UploadCapability | null): string | null {
  const name = file.name.toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'Only PDF, PNG and JPEG files can be uploaded.';
  }
  if (file.size === 0) return 'The file is empty.';
  const max = uploads?.maxBytes;
  if (max && file.size > max) {
    return `The file is ${formatBytes(file.size)}; the limit is ${formatBytes(max)}.`;
  }
  return null;
}

/** Upload availability for the forms below (pages that already know it provide it). */
export const UploadCapabilityContext = createContext<UploadCapability | null | undefined>(
  undefined,
);

/** The provided capability, or fetched once for this component (disabled until known). */
export function useUploadCapability(): UploadCapability | null {
  const provided = useContext(UploadCapabilityContext);
  const [fetched, setFetched] = useState<UploadCapability | null>(null);
  useEffect(() => {
    if (provided !== undefined) return;
    let active = true;
    Promise.resolve()
      .then(() => documentsApi.organizations())
      .then((result) => {
        if (active) setFetched(result?.uploads ?? null);
      })
      .catch(() => {
        if (active) setFetched(null);
      });
    return () => {
      active = false;
    };
  }, [provided]);
  return provided !== undefined ? provided : fetched;
}

/** One upload at a time with progress and cancellation. */
export function useUploader() {
  const [progress, setProgress] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const upload = useCallback(async (target: UploadTarget, file: File) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setProgress(0);
    try {
      return await documentsApi.upload(target, file, {
        signal: abort.signal,
        onProgress: (sent, total) => setProgress(total > 0 ? Math.min(1, sent / total) : 0),
      });
    } finally {
      if (controller.current === abort) controller.current = null;
      setProgress(null);
    }
  }, []);
  const cancel = useCallback(() => controller.current?.abort(), []);
  useEffect(() => () => controller.current?.abort(), []);
  return { progress, uploading: progress !== null, upload, cancel };
}

export type Uploader = ReturnType<typeof useUploader>;

/** Upload ids the server will not accept again: choose the file again. */
const STALE_UPLOAD_CODES = new Set([
  'DOCUMENT_UPLOAD_USED',
  'DOCUMENT_UPLOAD_EXPIRED',
  'DOCUMENT_UPLOAD_INVALID',
]);

/**
 * Uploads the chosen file once (kept in the form, so a retry after a failed save reuses the
 * same upload), then saves with its id. An upload the server no longer accepts is forgotten so
 * the next attempt uploads again.
 */
export async function saveWithUpload<T>(
  form: VersionFormState,
  setForm: (patch: Partial<VersionFormState>) => void,
  target: UploadTarget,
  uploader: Uploader,
  save: (uploadId: string | null) => Promise<T>,
): Promise<T> {
  let uploadId: string | null = null;
  if (form.provider === 'INTERNAL_OBJECT_STORAGE') {
    let uploaded = form.uploaded;
    if (!uploaded) {
      if (!form.file) throw new Error('Choose a file to upload.');
      uploaded = await uploader.upload(target, form.file);
      setForm({ uploaded });
    }
    uploadId = uploaded.id;
  }
  try {
    return await save(uploadId);
  } catch (error) {
    if (STALE_UPLOAD_CODES.has(documentsErrorCode(error) ?? '')) setForm({ uploaded: null });
    throw error;
  }
}

const SCAN_LABELS: Record<ScanStatus, string> = {
  NOT_SCANNED: 'Not scanned',
  PENDING: 'Malware scan pending',
  CLEAN: 'Scanned: no malware found',
  INFECTED: 'Blocked: malware found',
  FAILED: 'Malware scan failed',
};

export function scanLabel(status: ScanStatus): string {
  return SCAN_LABELS[status];
}

/** Name, size, type and scan state of an uploaded file. */
export function FileSummary({ file }: { file: StoredFile }) {
  return (
    <span className="text-xs text-slate-600">
      {[
        file.fileName,
        formatBytes(file.sizeBytes),
        fileTypeName(file.mimeType),
        scanLabel(file.scanStatus),
      ].join(' · ')}
    </span>
  );
}

/**
 * Downloads one uploaded file: a fresh 60-second link is requested (authorization is checked
 * again) and used at once; the link itself is never shown or kept.
 */
export function DownloadButton({
  file,
  name,
  getLink,
}: {
  file: StoredFile;
  name: string;
  getLink(): Promise<DownloadLink>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!file.downloadable) {
    return (
      <span className="text-xs text-amber-800">
        {file.scanStatus === 'INFECTED'
          ? 'This file was blocked by the malware scan and cannot be downloaded.'
          : 'This file cannot be downloaded until its malware scan is complete.'}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={secondaryButton}
        disabled={busy}
        aria-label={`Download ${name} (${file.fileName})`}
        onClick={() => {
          setBusy(true);
          setError(null);
          getLink()
            .then((link) => startDownload(link))
            .catch((cause: unknown) =>
              setError(documentsErrorMessage(cause, 'The file could not be downloaded.')),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Preparing download…' : 'Download'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-rose-800">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Where a version is kept: an uploaded file (with a download button when allowed), a link only
 * for https URLs (opened in a new tab without the opener or referrer), or the provider and file
 * name as text. Internal storage keys are never shown.
 */
export function ReferenceText({
  reference,
  text,
  name,
  getLink,
}: {
  reference: StorageReference;
  text?: string;
  /** What the download button names (e.g. the document title and version). */
  name?: string;
  getLink?: () => Promise<DownloadLink>;
}) {
  if (reference.file) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <FileSummary file={reference.file} />
        {getLink && (
          <DownloadButton
            file={reference.file}
            name={name ?? reference.file.fileName}
            getLink={getLink}
          />
        )}
      </span>
    );
  }
  if (reference.legacyReference) {
    return (
      <span className="text-xs text-slate-600">
        Earlier internal storage reference{reference.fileName ? ` (${reference.fileName})` : ''} —
        not available for download.
      </span>
    );
  }
  const details = [
    PROVIDER_LABELS[reference.provider],
    reference.externalFileId,
    reference.fileName,
  ].filter(Boolean);
  return (
    <span className="text-sm text-slate-700">
      {isHttpsUrl(reference.externalUrl) && (
        <>
          <SafeLink href={reference.externalUrl}>{text ?? 'Open document'}</SafeLink>{' '}
        </>
      )}
      <span className="text-xs text-slate-500">{details.join(' · ')}</span>
    </span>
  );
}

/** The editable fields of a storage reference (and, for documents, its dates and note). */
export interface VersionFormState {
  provider: StorageProvider;
  externalUrl: string;
  externalFileId: string;
  fileName: string;
  /** The chosen file (uploaded on save). */
  file: File | null;
  /** The upload of `file`, once accepted (kept so a retried save does not upload again). */
  uploaded: UploadedFile | null;
  issuedOn: string;
  effectiveOn: string;
  expiresOn: string;
  note: string;
}

export const emptyVersion = (provider: StorageProvider = 'EXTERNAL_URL'): VersionFormState => ({
  provider,
  externalUrl: '',
  externalFileId: '',
  fileName: '',
  file: null,
  uploaded: null,
  issuedOn: '',
  effectiveOn: '',
  expiresOn: '',
  note: '',
});

/** Uploads first when they are available. */
export const defaultProvider = (uploads: UploadCapability | null): StorageProvider =>
  uploads?.enabled ? 'INTERNAL_OBJECT_STORAGE' : 'EXTERNAL_URL';

const usesUrl = (provider: StorageProvider) =>
  provider === 'EXTERNAL_URL' || provider === 'GOOGLE_DRIVE';

/** Only the fields the chosen provider uses (blank fields are sent as null). */
export function referenceInput(form: VersionFormState, uploadId: string | null = null) {
  if (form.provider === 'INTERNAL_OBJECT_STORAGE') {
    return { provider: form.provider, uploadId };
  }
  const value = (text: string) => text.trim() || null;
  return {
    provider: form.provider,
    externalUrl: usesUrl(form.provider) ? value(form.externalUrl) : null,
    externalFileId: form.provider === 'GOOGLE_DRIVE' ? value(form.externalFileId) : null,
    fileName: value(form.fileName),
  };
}

export function versionInput(form: VersionFormState, uploadId: string | null = null): VersionInput {
  return {
    ...referenceInput(form, uploadId),
    issuedOn: form.issuedOn || null,
    effectiveOn: form.effectiveOn || null,
    expiresOn: form.expiresOn || null,
    note: form.note.trim() || null,
  };
}

/** A client-side check mirroring the API's reference rules, or null when the form is fine. */
export function referenceProblem(
  form: VersionFormState,
  expiryRequired = false,
  uploads: UploadCapability | null = null,
): string | null {
  const url = form.externalUrl.trim();
  if (usesUrl(form.provider) && url && !isHttpsUrl(url)) {
    return 'Document links must start with https://.';
  }
  if (form.provider === 'EXTERNAL_URL' && !url) return 'Add the https link to the document.';
  if (form.provider === 'GOOGLE_DRIVE' && !url && !form.externalFileId.trim()) {
    return 'Add the Google Drive link or file ID.';
  }
  if (form.provider === 'INTERNAL_OBJECT_STORAGE' && !form.uploaded) {
    if (!form.file) return 'Choose a file to upload.';
    const problem = fileProblem(form.file, uploads);
    if (problem) return problem;
  }
  if (expiryRequired && !form.expiresOn) return 'This type of document needs its expiry date.';
  if (form.issuedOn && form.expiresOn && form.expiresOn < form.issuedOn) {
    return 'The expiry date cannot be before the issue date.';
  }
  return null;
}

/** An accessible file chooser with the chosen file's name, size and type, and upload progress. */
export function FileInput({
  form,
  onChange,
  uploads,
  uploader,
}: {
  form: VersionFormState;
  onChange(patch: Partial<VersionFormState>): void;
  uploads: UploadCapability | null;
  uploader?: Uploader;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const statusId = `${id}-status`;
  const problem = form.file && !form.uploaded ? fileProblem(form.file, uploads) : null;
  const limit = uploads?.maxBytes ? `, up to ${formatBytes(uploads.maxBytes)}` : '';
  return (
    <div className="space-y-1 sm:col-span-3">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        File
      </label>
      <input
        id={id}
        type="file"
        accept={ACCEPT}
        aria-required={!form.uploaded}
        disabled={uploader?.uploading}
        aria-describedby={`${hintId} ${statusId}`}
        aria-invalid={problem ? true : undefined}
        className="block w-full max-w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-200"
        onChange={(event) =>
          onChange({ file: event.currentTarget.files?.[0] ?? null, uploaded: null })
        }
      />
      <p id={hintId} className="text-xs text-slate-600">
        PDF, PNG or JPEG{limit}. The file is checked on upload and saved as a new, unchangeable
        version.
      </p>
      <div id={statusId} aria-live="polite" className="text-xs text-slate-700">
        {form.file && (
          <p className="break-all">
            {form.file.name} · {formatBytes(form.file.size)} ·{' '}
            {fileTypeName(form.file.type || null)}
            {form.uploaded ? ' · uploaded' : ''}
          </p>
        )}
        {problem && <p className="text-rose-800">{problem}</p>}
      </div>
      {uploader?.uploading && (
        <div className="flex flex-wrap items-center gap-2">
          <progress
            className="h-2 w-48 max-w-full"
            max={1}
            value={uploader.progress ?? 0}
            aria-label="Upload progress"
          />
          <span className="text-xs text-slate-700">
            {Math.round((uploader.progress ?? 0) * 100)}%
          </span>
          <button type="button" className={secondaryButton} onClick={uploader.cancel}>
            Cancel upload
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A version form's state with uploads offered first once they are known to be available (unless
 * the user already chose where the document is kept), the upload capability and an uploader.
 */
export function useVersionForm() {
  const uploads = useUploadCapability();
  const uploader = useUploader();
  const [form, setForm] = useState<VersionFormState>(() => emptyVersion());
  const chosen = useRef(false);
  useEffect(() => {
    if (!uploads?.enabled || chosen.current) return;
    setForm((current) =>
      current.provider === 'EXTERNAL_URL'
        ? { ...current, provider: 'INTERNAL_OBJECT_STORAGE' }
        : current,
    );
  }, [uploads]);
  const update = useCallback((patch: Partial<VersionFormState>) => {
    if (patch.provider) chosen.current = true;
    setForm((current) => ({ ...current, ...patch }));
  }, []);
  const reset = useCallback(() => {
    chosen.current = false;
    setForm(emptyVersion(defaultProvider(uploads)));
  }, [uploads]);
  return { form, update, reset, uploads, uploader };
}

/** Provider select plus the fields that provider uses. */
export function ReferenceFields({
  form,
  onChange,
  uploads = null,
  uploader,
}: {
  form: VersionFormState;
  onChange(patch: Partial<VersionFormState>): void;
  uploads?: UploadCapability | null;
  uploader?: Uploader;
}) {
  const providers = PROVIDERS.filter(
    (provider) =>
      provider !== 'INTERNAL_OBJECT_STORAGE' ||
      uploads?.enabled ||
      form.provider === 'INTERNAL_OBJECT_STORAGE',
  );
  return (
    <>
      <Field label="Stored in">
        <select
          className={inputClass}
          value={form.provider}
          disabled={uploader?.uploading}
          onChange={(e) => onChange({ provider: e.currentTarget.value as StorageProvider })}
        >
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </option>
          ))}
        </select>
      </Field>
      {form.provider === 'INTERNAL_OBJECT_STORAGE' ? (
        <FileInput form={form} onChange={onChange} uploads={uploads} uploader={uploader} />
      ) : (
        <>
          {usesUrl(form.provider) && (
            <Field label={form.provider === 'GOOGLE_DRIVE' ? 'Drive link (https)' : 'Link (https)'}>
              <input
                className={inputClass}
                type="url"
                required={form.provider === 'EXTERNAL_URL'}
                value={form.externalUrl}
                onChange={(e) => onChange({ externalUrl: e.currentTarget.value })}
              />
            </Field>
          )}
          {form.provider === 'GOOGLE_DRIVE' && (
            <Field label="Drive file ID">
              <input
                className={inputClass}
                value={form.externalFileId}
                onChange={(e) => onChange({ externalFileId: e.currentTarget.value })}
              />
            </Field>
          )}
          <Field label="File name">
            <input
              className={inputClass}
              value={form.fileName}
              onChange={(e) => onChange({ fileName: e.currentTarget.value })}
            />
          </Field>
        </>
      )}
      {form.provider === 'MANUAL_REFERENCE' && (
        <p className="text-xs text-slate-600 sm:col-span-3">
          A manual reference records that a paper or offline document exists; describe where it is
          kept in the note.
        </p>
      )}
    </>
  );
}

/** Reference fields plus the version's dates and note. */
export function VersionFields({
  form,
  onChange,
  expiryRequired = false,
  uploads = null,
  uploader,
}: {
  form: VersionFormState;
  onChange(patch: Partial<VersionFormState>): void;
  expiryRequired?: boolean;
  uploads?: UploadCapability | null;
  uploader?: Uploader;
}) {
  return (
    <>
      <ReferenceFields form={form} onChange={onChange} uploads={uploads} uploader={uploader} />
      <Field label="Issued on">
        <input
          className={inputClass}
          type="date"
          value={form.issuedOn}
          onChange={(e) => onChange({ issuedOn: e.currentTarget.value })}
        />
      </Field>
      <Field label="Effective on">
        <input
          className={inputClass}
          type="date"
          value={form.effectiveOn}
          onChange={(e) => onChange({ effectiveOn: e.currentTarget.value })}
        />
      </Field>
      <Field label="Expires on">
        <input
          className={inputClass}
          type="date"
          required={expiryRequired}
          value={form.expiresOn}
          onChange={(e) => onChange({ expiresOn: e.currentTarget.value })}
        />
      </Field>
      <div className="sm:col-span-3">
        <Field label="Version note">
          <textarea
            className={inputClass}
            rows={2}
            value={form.note}
            onChange={(e) => onChange({ note: e.currentTarget.value })}
          />
        </Field>
      </div>
    </>
  );
}

/**
 * Adds a new version (a renewal, correction or replacement); earlier versions are kept and
 * marked superseded by the API. With uploads, the file is uploaded first (with progress and a
 * cancel button) and then attached; a failed save can be retried without uploading again.
 */
export function AddVersionForm({
  name,
  expiryRequired,
  busy,
  run,
  target,
  onSubmit,
  onDone,
}: {
  name: string;
  expiryRequired: boolean;
  busy: boolean;
  run: Run;
  /** Where an upload is for (the document). */
  target: UploadTarget;
  onSubmit(input: VersionInput): Promise<unknown>;
  onDone(): void;
}) {
  const { form, update, uploads, uploader } = useVersionForm();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-label={`Add version to ${name}`}
      className="grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const found = referenceProblem(form, expiryRequired, uploads);
        setProblem(found);
        if (found) return;
        void run(
          () =>
            saveWithUpload(form, update, target, uploader, (uploadId) =>
              onSubmit(versionInput(form, uploadId)),
            ),
          'New version added.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <VersionFields
        form={form}
        expiryRequired={expiryRequired}
        uploads={uploads}
        uploader={uploader}
        onChange={update}
      />
      {expiryRequired && (
        <p className="text-xs text-slate-600 sm:col-span-3">
          This type of document is expiry-tracked: give the new version its expiry date.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy || uploader.uploading}>
          {uploader.uploading ? 'Uploading…' : 'Save new version'}
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
