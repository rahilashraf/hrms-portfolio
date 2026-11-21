import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { domainError } from '../common/domain-support.js';
import {
  DocumentFileService,
  type UploadTarget,
} from './document-file.service.js';
import { DocumentOptionsService } from './document-options.service.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { domainRequestContext } from '../calendar/holiday.controller.js';
import { DocumentsAccessService } from './documents-access.service.js';
import { DocumentTypeService } from './document-type.service.js';
import { EmployeeDocumentService } from './employee-document.service.js';
import { PolicyDocumentService } from './policy-document.service.js';
import {
  AcknowledgeDto,
  CopyPolicyDto,
  ReplaceRequirementDto,
  CreateDocumentDto,
  CreatePolicyDto,
  CreateRequirementDto,
  CreateTypeDto,
  DocumentOptionsQueryDto,
  ExpiryQueryDto,
  HandoffDto,
  InitializeTypesDto,
  OrganizationQueryDto,
  PolicyVersionDto,
  ProvideDocumentDto,
  RequiredReasonDto,
  UpdateDocumentDto,
  UpdatePolicyDto,
  UpdateTypeDto,
  UploadTargetDto,
  VersionDto,
} from './documents.dto.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';

/**
 * Phase 15 — Documents & Employee Records. Every route is authenticated; authorization
 * (document.* scoped through the employee's assignments, confidentiality clearance,
 * organization-level types and policies, the employee's own self-service) is decided in the
 * services.
 */
@Controller('documents')
@UseGuards(AccessTokenGuard)
export class DocumentsController {
  constructor(
    private readonly access: DocumentsAccessService,
    private readonly types: DocumentTypeService,
    private readonly documents: EmployeeDocumentService,
    private readonly policies: PolicyDocumentService,
    private readonly files: DocumentFileService,
    private readonly options: DocumentOptionsService,
  ) {}

  // ─── Batch 9: files ────────────────────────────────────────────────────────

  /**
   * A streamed multipart upload (one `file` field). The target is authorized before any byte
   * of the body is read; the response describes the upload (never its storage key). The id is
   * then given as `uploadId` when creating the record or version it is for.
   */
  @Post('uploads')
  @RateLimit(...RATE_LIMITS.documentUpload)
  async upload(
    @Query() query: UploadTargetDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    const target = uploadTarget(query);
    const authorized = await this.files.authorize(identity.userId, target);
    return this.files.receive(
      authorized,
      { headers: request.headers, stream: request },
      domainRequestContext(identity, request),
    );
  }

  /** A 60-second download URL for one version (authorized on every request). */
  @Post('records/:documentId/versions/:versionId/download-url')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.documentViewUrl)
  downloadUrl(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.files.employeeVersionUrl(
      identity.userId,
      documentId,
      versionId,
      domainRequestContext(identity, request),
    );
  }

  @Post('policies/:policyId/versions/:versionId/download-url')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.documentViewUrl)
  policyDownloadUrl(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.files.policyVersionUrl(
      identity.userId,
      policyId,
      versionId,
      domainRequestContext(identity, request),
    );
  }

  /** Batch 9 (F5): departments and positions for requirement and policy pickers. */
  @Get('options')
  documentOptions(
    @Query() query: DocumentOptionsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.options.options(identity.userId, query);
  }

  @Get('organizations')
  async organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return {
      ...(await this.access.organizations(identity.userId)),
      uploads: this.files.uploads,
    };
  }

  // ─── Self-service ─────────────────────────────────────────────────────────

  @Get('me')
  mine(@AuthUser() identity: AuthenticatedIdentity) {
    return this.documents.mine(identity.userId);
  }

  @Get('me/policies')
  myPolicies(@AuthUser() identity: AuthenticatedIdentity) {
    return this.policies.mine(identity.userId);
  }

  @Post('me/provide')
  @RateLimit(...RATE_LIMITS.documentsProvide)
  provide(
    @Body() body: ProvideDocumentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.documents.provide(
      body,
      domainRequestContext(identity, request),
    );
  }

  // ─── Types and requirements ───────────────────────────────────────────────

  @Get('types')
  listTypes(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.types.list(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post('types')
  createType(
    @Body() body: CreateTypeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.create(body, domainRequestContext(identity, request));
  }

  @Post('types/initialize')
  initializeTypes(
    @Body() body: InitializeTypesDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.initializeDefaults(
      body.organizationId,
      domainRequestContext(identity, request),
    );
  }

  @Patch('types/:typeId')
  updateType(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Body() body: UpdateTypeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.update(
      typeId,
      body,
      domainRequestContext(identity, request),
    );
  }

  /** Batch 9 (D10): an archived type becomes available again. */
  @Post('types/:typeId/reactivate')
  @HttpCode(200)
  reactivateType(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.reactivate(
      typeId,
      domainRequestContext(identity, request),
    );
  }

  /** Batch 9 (D10): archive a requirement and add its replacement, atomically. */
  @Post('requirements/:requirementId/replace')
  @HttpCode(200)
  replaceRequirement(
    @Param('requirementId', ParseUUIDPipe) requirementId: string,
    @Body() body: ReplaceRequirementDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.replaceRequirement(
      requirementId,
      body,
      domainRequestContext(identity, request),
    );
  }

  /** Batch 9 (D10): a retired policy copied into a new draft (history untouched). */
  @Post('policies/:policyId/copy')
  copyPolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: CopyPolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.copyRetired(
      policyId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('types/:typeId/archive')
  archiveType(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.archive(typeId, domainRequestContext(identity, request));
  }

  @Get('requirements')
  requirements(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.types.requirements(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post('requirements')
  createRequirement(
    @Body() body: CreateRequirementDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.createRequirement(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('requirements/:requirementId/archive')
  archiveRequirement(
    @Param('requirementId', ParseUUIDPipe) requirementId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.types.archiveRequirement(
      requirementId,
      domainRequestContext(identity, request),
    );
  }

  // ─── Employee records ─────────────────────────────────────────────────────

  @Post('records')
  create(
    @Body() body: CreateDocumentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.documents.create(body, domainRequestContext(identity, request));
  }

  @Get('records/:documentId')
  detail(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.documents.detail(identity.userId, documentId);
  }

  @Patch('records/:documentId')
  update(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: UpdateDocumentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.documents.update(
      documentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('records/:documentId/versions')
  addVersion(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: VersionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.documents.addVersion(
      documentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('records/:documentId/archive')
  archive(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.documents.archive(
      documentId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Get('employees/:employeeId')
  employeeRecords(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.documents.employeeRecords(identity.userId, employeeId);
  }

  @Get('expiring')
  expiring(
    @Query() query: ExpiryQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.documents.expiryDashboard(
      identity.userId,
      query.organizationId,
      query.withinDays,
    );
  }

  @Get('missing')
  missing(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.documents.missingDashboard(
      identity.userId,
      query.organizationId,
    );
  }

  /** Explicit hand-off of selected candidate documents after a Phase 13 hire. */
  @Post('handoff/:hireId')
  handoff(
    @Param('hireId', ParseUUIDPipe) hireId: string,
    @Body() body: HandoffDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.documents.handoffFromRecruitment(
      hireId,
      body,
      domainRequestContext(identity, request),
    );
  }

  // ─── Policies ─────────────────────────────────────────────────────────────

  @Get('policies')
  listPolicies(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.policies.list(identity.userId, query.organizationId);
  }

  @Post('policies')
  createPolicy(
    @Body() body: CreatePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.create(body, domainRequestContext(identity, request));
  }

  @Patch('policies/:policyId')
  updatePolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: UpdatePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.update(
      policyId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('policies/:policyId/versions')
  createPolicyVersion(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: PolicyVersionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.createVersion(
      policyId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('policies/:policyId/versions/:versionId/publish')
  publish(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.publish(
      policyId,
      versionId,
      domainRequestContext(identity, request),
    );
  }

  @Post('policies/:policyId/retire')
  retire(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.retire(
      policyId,
      domainRequestContext(identity, request),
    );
  }

  @Post('policies/:policyId/versions/:versionId/acknowledge')
  acknowledge(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: AcknowledgeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.acknowledge(
      policyId,
      versionId,
      body.statementAccepted,
      domainRequestContext(identity, request),
    );
  }

  @Get('policies/:policyId/acknowledgements')
  tracking(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.policies.tracking(identity.userId, policyId);
  }
}

/**
 * Batch 9 — local-storage downloads. Not behind the access token: the URL itself is a 60-second
 * HMAC token bound to one stored object, issued only after authorization (the S3 equivalent is a
 * presigned URL). Invalid, expired or unavailable → 404.
 */
@Controller('documents/files')
export class DocumentFilesController {
  constructor(private readonly files: DocumentFileService) {}

  @Get(':token')
  @RateLimit(...RATE_LIMITS.documentFileDownload)
  async download(@Param('token') token: string, @Res() response: Response) {
    const file = await this.files.localDownload(token);
    for (const [name, value] of Object.entries(file.headers))
      response.setHeader(name, value);
    file.stream.on('error', () => response.destroy());
    file.stream.pipe(response);
  }
}

function uploadTarget(query: UploadTargetDto): UploadTarget {
  const invalid = () =>
    new BadRequestException(
      domainError(
        400,
        'DOCUMENT_UPLOAD_TARGET_INVALID',
        'Give exactly one target: organizationId + employeeId, documentId, organizationId + self=true, or policyId.',
      ),
    );
  if (query.documentId) {
    if (
      query.organizationId ||
      query.employeeId ||
      query.policyId ||
      query.self
    )
      throw invalid();
    return { kind: 'version', documentId: query.documentId };
  }
  if (query.policyId) {
    if (query.organizationId || query.employeeId || query.self) throw invalid();
    return { kind: 'policy', policyId: query.policyId };
  }
  if (query.organizationId && query.self && !query.employeeId)
    return { kind: 'self', organizationId: query.organizationId };
  if (query.organizationId && query.employeeId && !query.self)
    return {
      kind: 'record',
      organizationId: query.organizationId,
      employeeId: query.employeeId,
    };
  throw invalid();
}
