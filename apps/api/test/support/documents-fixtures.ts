import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { DocumentsAuditAdapter } from '../../src/documents/documents-audit.js';
import { DocumentTypeService } from '../../src/documents/document-type.service.js';
import { DocumentsAccessService } from '../../src/documents/documents-access.service.js';
import { DocumentsClock } from '../../src/documents/documents-common.js';
import { EmployeeDocumentService } from '../../src/documents/employee-document.service.js';
import { Readable } from 'node:stream';
import { DocumentFileService } from '../../src/documents/document-file.service.js';
import type { DocumentStorageSettings } from '../../src/documents/document-object-store.js';
import type { DocumentMalwareScanner } from '../../src/documents/document-scanner.js';
import { DocumentOptionsService } from '../../src/documents/document-options.service.js';
import { PolicyDocumentService } from '../../src/documents/policy-document.service.js';
import { RecruitmentAccessService } from '../../src/recruitment/recruitment-access.service.js';
import type { SchedulingFixtures, UserSpec } from './scheduling-fixtures.js';

export const DOCUMENT_PERMISSION_KEYS = [
  'document.read',
  'document.confidential.read',
  'document.restricted.read',
  'document.manage',
  'document.type.manage',
  'document.policy.manage',
] as const;

/** Users of document specs: record access is never implied by HR, payroll or a reporting line. */
export const DOCUMENT_USERS: Record<string, UserSpec[]> = {
  typeAdmin: [{ permissions: ['document.type.manage'], scope: 'org' }],
  policyAdmin: [{ permissions: ['document.policy.manage'], scope: 'org' }],
  reader: [{ permissions: ['document.read'], scope: 'org' }],
  hrRecords: [
    {
      permissions: [
        'document.read',
        'document.confidential.read',
        'document.manage',
      ],
      scope: 'org',
    },
  ],
  restricted: [
    {
      permissions: [
        'document.read',
        'document.confidential.read',
        'document.restricted.read',
        'document.manage',
      ],
      scope: 'org',
    },
  ],
  teamRecords: [
    { permissions: ['document.read', 'document.manage'], scope: 'teamA' },
  ],
  deptBReader: [{ permissions: ['document.read'], scope: 'deptB' }],
  hr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'payroll.read',
        'payroll.manage',
        'compensation.manage',
        'performance.manage',
        'recruitment.read',
        'onboarding.manage',
      ],
      scope: 'org',
    },
  ],
  orgBAdmin: [{ permissions: DOCUMENT_PERMISSION_KEYS, scope: 'orgB' }],
  /** Employee 1's own account with full document rights: never manages their own records. */
  self1: [{ permissions: DOCUMENT_PERMISSION_KEYS, scope: 'org' }],
  onboardingHr: [
    { permissions: ['onboarding.read', 'onboarding.manage'], scope: 'org' },
  ],
  templateAdmin: [
    { permissions: ['onboarding.template.manage'], scope: 'org' },
  ],
  // Works in Org A without any permission (a role with none): may own onboarding tasks.
  itDesk: [{ permissions: [], scope: 'org' }],
};

export class FixedDocumentsClock extends DocumentsClock {
  value = new Date('2026-03-15T16:00:00.000Z');

  override now() {
    return this.value;
  }
}

export function documentServices(prisma: PrismaService, clock: DocumentsClock) {
  const authorization = new AuthorizationService(prisma);
  const access = new DocumentsAccessService(prisma, authorization);
  const audit = new DocumentsAuditAdapter(new AuditService(prisma));
  const types = new DocumentTypeService(prisma, access, audit, clock);
  const documents = new EmployeeDocumentService(
    prisma,
    access,
    audit,
    clock,
    types,
    new RecruitmentAccessService(prisma, authorization),
  );
  const policies = new PolicyDocumentService(
    prisma,
    access,
    audit,
    clock,
    documents,
  );
  const options = new DocumentOptionsService(prisma, access);
  return { access, types, documents, policies, options };
}

export type DocumentServices = ReturnType<typeof documentServices>;

export async function typeId(
  prisma: PrismaService,
  fx: SchedulingFixtures,
  code: string,
) {
  return (
    await prisma.documentType.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: fx.orgA, code } },
    })
  ).id;
}

/** Batch 9: a multipart request carrying one file (field `file`), optionally cut short. */
export function multipartFile(
  content: Buffer,
  fileName: string,
  options: { field?: string; truncateAt?: number } = {},
) {
  const boundary = `----b9${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${options.field ?? 'file'}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const sent =
    options.truncateAt !== undefined
      ? body.subarray(0, options.truncateAt)
      : body;
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    stream: Readable.from([sent]),
  };
}

/** Batch 9: the file service over a store (local by default) with an optional scanner. */
export function documentFileServices(
  prisma: PrismaService,
  clock: DocumentsClock,
  settings: DocumentStorageSettings,
  scanner: DocumentMalwareScanner | null = null,
) {
  const authorization = new AuthorizationService(prisma);
  const access = new DocumentsAccessService(prisma, authorization);
  const audit = new DocumentsAuditAdapter(new AuditService(prisma));
  return new DocumentFileService(
    prisma,
    access,
    audit,
    clock,
    settings,
    scanner,
  );
}
