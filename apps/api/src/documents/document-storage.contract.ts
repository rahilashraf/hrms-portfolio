import type {
  DocumentReferenceStatus,
  DocumentStorageProvider,
} from '../generated/prisma/client.js';

/**
 * Phase 15 — the provider-neutral storage boundary of Documents.
 *
 * The Documents domain stores metadata and references only (an https link, a provider file
 * id or an object-storage key) and never depends on a provider's API. A storage adapter (e.g.
 * the shared Google Workspace connector's Drive adapter in a later phase) registers under
 * DOCUMENT_STORAGE_ADAPTERS to:
 *
 * - check a reference (does the Drive file still exist / is it shared correctly?) — the
 *   documents.verify-references job records the result on the version (referenceStatus);
 * - resolve a viewing link for an authorized user (e.g. a short-lived signed URL for internal
 *   object storage) — callers authorize first; adapters never decide access;
 * - optionally create a folder for an employee's records (Drive), returned as a reference.
 *
 * Phase 15 registers no adapter, so references are kept as entered and reported UNKNOWN.
 * Batch 9 registers the internal object-storage adapter (internal-storage.adapter.ts) when
 * document storage is configured; resolveViewUrl is called only after the caller authorized
 * (DocumentFileService), with the stored object's own key.
 */

export interface StoredReference {
  provider: DocumentStorageProvider;
  externalUrl: string | null;
  storageKey: string | null;
  externalFileId: string | null;
  /**
   * Phase 16.5: the document's organization, so an adapter checks the reference with that
   * organization's own provider connection only.
   */
  organizationId?: string;
  /**
   * Batch 9: the uploaded object behind an INTERNAL_OBJECT_STORAGE version (null for a legacy
   * hand-typed key, which is never checked or opened as a stored file), with its display name
   * and detected type for downloads.
   */
  storedObjectId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}

/**
 * Phase 16.5: thrown by an adapter that cannot check a reference right now for a reason that is
 * not the reference's (e.g. the organization has no usable provider connection). The reference
 * is skipped — its status is left unchanged — rather than reported as a failure.
 */
export class StorageAdapterUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StorageAdapterUnavailableError';
  }
}

export interface DocumentStorageAdapter {
  readonly provider: DocumentStorageProvider;
  checkReference(
    reference: StoredReference,
  ): Promise<Exclude<DocumentReferenceStatus, 'UNKNOWN'>>;
  resolveViewUrl?(reference: StoredReference): Promise<string | null>;
  ensureEmployeeFolder?(input: {
    organizationId: string;
    employeeId: string;
    employeeNumber: string;
  }): Promise<{ externalUrl: string | null; externalFileId: string | null }>;
}

export const DOCUMENT_STORAGE_ADAPTERS = Symbol('DOCUMENT_STORAGE_ADAPTERS');

/**
 * The acknowledgement boundary Documents offers other domains (Phase 14 onboarding tasks):
 * records — once, idempotently — that an employee acknowledged the current published version
 * of a policy, in the caller's transaction. Acknowledging a version never covers later ones.
 */
export const DOCUMENT_ACKNOWLEDGEMENT = Symbol('DOCUMENT_ACKNOWLEDGEMENT');

export interface DocumentAcknowledgementContract {
  acknowledgeCurrentVersion(
    client: unknown,
    input: {
      organizationId: string;
      policyId: string;
      employeeId: string;
      userId: string;
      source: 'SELF_SERVICE' | 'ONBOARDING_TASK';
    },
  ): Promise<{
    acknowledgementId: string;
    policyVersionId: string;
    created: boolean;
    statement: string;
  }>;

  /** Whether the employee holds an active, unexpired document of the type (onboarding tasks). */
  validDocumentOfType(
    client: unknown,
    input: { organizationId: string; employeeId: string; typeId: string },
  ): Promise<{ documentId: string } | null>;
}
