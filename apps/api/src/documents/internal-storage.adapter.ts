import { DocumentsClock } from './documents-common.js';
import {
  StorageAdapterUnavailableError,
  type DocumentStorageAdapter,
  type StoredReference,
} from './document-storage.contract.js';
import type { DocumentObjectStore } from './document-object-store.js';

/**
 * Batch 9 — the DocumentStorageAdapter of INTERNAL_OBJECT_STORAGE over the configured object
 * store. References without a stored object (legacy hand-typed keys) are never checked or opened
 * (F4): the reference check skips them. Download links are issued only by DocumentFileService
 * (authorization and scan state first), never by this adapter;
 * the adapter never decides access.
 */
export class InternalObjectStorageAdapter implements DocumentStorageAdapter {
  readonly provider = 'INTERNAL_OBJECT_STORAGE' as const;

  constructor(
    private readonly store: DocumentObjectStore,
    private readonly clock = new DocumentsClock(),
  ) {}

  async checkReference(reference: StoredReference) {
    if (!reference.storedObjectId || !reference.storageKey)
      throw new StorageAdapterUnavailableError('LEGACY_REFERENCE');
    return (await this.store.head(reference.storageKey))
      ? ('OK' as const)
      : ('MISSING' as const);
  }
}
