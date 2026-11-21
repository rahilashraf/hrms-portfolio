import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  writeDocumentsAudit,
  type DocumentsRequestContext,
  type Tx,
} from './documents-common.js';

/** Audit writer shared by the document services: entity references and redacted metadata only. */
@Injectable()
export class DocumentsAuditAdapter {
  constructor(private readonly audit: AuditService) {}

  write(
    tx: Tx,
    action: string,
    entityType: string,
    entityId: string,
    context: DocumentsRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writeDocumentsAudit(this.audit, tx, {
      action,
      entityType,
      entityId,
      context,
      metadata,
    });
  }
}
