import { Module } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { RecruitmentModule } from '../recruitment/recruitment.module.js';
import { GoogleWorkspaceCoreModule } from '../integrations/google/google-workspace-core.module.js';
import { GoogleDriveStorageAdapter } from '../integrations/google/google-workspace.adapters.js';
import {
  DOCUMENT_ACKNOWLEDGEMENT,
  DOCUMENT_STORAGE_ADAPTERS,
} from './document-storage.contract.js';
import { DocumentsAuditAdapter } from './documents-audit.js';
import { DocumentTypeService } from './document-type.service.js';
import { DocumentsAccessService } from './documents-access.service.js';
import { DocumentsClock } from './documents-common.js';
import {
  DocumentFilesController,
  DocumentsController,
} from './documents.controller.js';
import {
  DOCUMENT_STORAGE_SETTINGS,
  DocumentFileService,
} from './document-file.service.js';
import {
  documentStorageFromEnv,
  type DocumentStorageSettings,
} from './document-object-store.js';
import { DocumentOptionsService } from './document-options.service.js';
import {
  DOCUMENT_MALWARE_SCANNER,
  type DocumentMalwareScanner,
} from './document-scanner.js';
import { InternalObjectStorageAdapter } from './internal-storage.adapter.js';
import { EmployeeDocumentService } from './employee-document.service.js';
import { PolicyDocumentService } from './policy-document.service.js';

/**
 * Phase 15 — Documents & Employee Records: organization document types and requirements,
 * employee records with versioned provider-neutral storage references (never file contents),
 * confidentiality levels, date-derived expiry, policy documents with per-version
 * acknowledgements, an explicit hand-off of recruitment documents after hire, and the
 * acknowledgement contract Phase 14 onboarding tasks use. Google Drive support is the storage
 * adapter registered by Phase 16.5 (Google Workspace); no Google API is called here.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    RecruitmentModule,
    GoogleWorkspaceCoreModule,
  ],
  controllers: [DocumentsController, DocumentFilesController],
  providers: [
    AccessTokenGuard,
    DocumentsAccessService,
    DocumentsAuditAdapter,
    DocumentsClock,
    DocumentTypeService,
    EmployeeDocumentService,
    PolicyDocumentService,
    { provide: DOCUMENT_ACKNOWLEDGEMENT, useExisting: PolicyDocumentService },
    DocumentOptionsService,
    // Batch 9: document storage from the environment (validated at startup), no scanner by
    // default (files are recorded NOT_SCANNED), and the file service.
    {
      provide: DOCUMENT_STORAGE_SETTINGS,
      useFactory: (): DocumentStorageSettings => documentStorageFromEnv(),
    },
    { provide: DOCUMENT_MALWARE_SCANNER, useValue: null },
    {
      provide: DocumentFileService,
      inject: [
        PrismaService,
        DocumentsAccessService,
        DocumentsAuditAdapter,
        DocumentsClock,
        DOCUMENT_STORAGE_SETTINGS,
        DOCUMENT_MALWARE_SCANNER,
      ],
      useFactory: (
        prisma: PrismaService,
        access: DocumentsAccessService,
        audit: DocumentsAuditAdapter,
        clock: DocumentsClock,
        settings: DocumentStorageSettings,
        scanner: DocumentMalwareScanner | null,
      ) =>
        new DocumentFileService(
          prisma,
          access,
          audit,
          clock,
          settings,
          scanner,
        ),
    },
    // Phase 16.5: the Google Drive adapter (per-organization connection; skipped when none);
    // Batch 9: the internal object-storage adapter when storage is configured.
    {
      provide: DOCUMENT_STORAGE_ADAPTERS,
      inject: [GoogleDriveStorageAdapter, DOCUMENT_STORAGE_SETTINGS],
      useFactory: (
        drive: GoogleDriveStorageAdapter,
        settings: DocumentStorageSettings,
      ) => [
        drive,
        ...(settings.store
          ? [new InternalObjectStorageAdapter(settings.store)]
          : []),
      ],
    },
  ],
  exports: [
    DOCUMENT_ACKNOWLEDGEMENT,
    DOCUMENT_STORAGE_ADAPTERS,
    // Phase 20: dashboard counts and employee capability flags reuse the domain's own access.
    DocumentsAccessService,
    EmployeeDocumentService,
    PolicyDocumentService,
  ],
})
export class DocumentsModule {}
