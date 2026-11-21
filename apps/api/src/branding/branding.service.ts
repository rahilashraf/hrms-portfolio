import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import {
  advisoryLock,
  domainError,
  requireActor,
  type DomainClient,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type OrganizationBranding,
} from '../generated/prisma/client.js';
import { requireOrganizationContext } from '../workspace/workspace-scope.js';
import {
  changedBrandingFields,
  EMPTY_BRANDING,
  normalizeBranding,
  resolvePublicBranding,
  type BrandingInput,
  type BrandingValues,
  type PublicBranding,
} from './branding-domain.js';

export const BRANDING_MANAGE = 'organization.branding.manage';
const BRANDING_READERS = ['organization.read', BRANDING_MANAGE] as const;

const versionConflict = (currentVersion: number) =>
  new ConflictException(
    domainError(
      409,
      'BRANDING_VERSION_CONFLICT',
      'The branding changed since it was loaded; reload and try again.',
      { currentVersion },
    ),
  );

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function valuesOf(row: OrganizationBranding | null): BrandingValues {
  if (!row) return { ...EMPTY_BRANDING };
  return {
    displayName: row.displayName,
    shortName: row.shortName,
    logoUrl: row.logoUrl,
    iconUrl: row.iconUrl,
    loginLogoUrl: row.loginLogoUrl,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    loginSubtitle: row.loginSubtitle,
    websiteUrl: row.websiteUrl,
    supportEmail: row.supportEmail,
    publicLoginEnabled: row.publicLoginEnabled,
  };
}

/**
 * Phase 20 — organization branding. Reading needs organization.read or
 * organization.branding.manage at the organization; changing needs organization.branding.manage
 * there, under optimistic concurrency (`expectedVersion`, 0 = never set) and an
 * organization-level advisory lock. Every change is audited with field NAMES and flags only —
 * never URLs, colors, text or the support email. Branding is display data: it never grants
 * anything and is never feature-gated.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  view(organizationId: string, row: OrganizationBranding | null) {
    const values = valuesOf(row);
    return {
      organizationId,
      ...values,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedByUserId: row?.updatedByUserId ?? null,
    };
  }

  private async requireAccess(
    userId: string,
    organizationId: string,
    permissions: readonly string[],
    client: DomainClient = this.prisma,
  ) {
    const grants = await this.authorization.effectiveGrants(
      userId,
      new Date(),
      client,
    );
    const context = await requireOrganizationContext(
      client,
      grants,
      userId,
      organizationId,
    );
    if (!permissions.some((permission) => context.atOrganization(permission)))
      throw new ForbiddenException(
        `Missing permission ${permissions.at(-1)} for the organization.`,
      );
    return context;
  }

  async get(userId: string, organizationId: string) {
    await this.requireAccess(userId, organizationId, BRANDING_READERS);
    const row = await this.prisma.organizationBranding.findUnique({
      where: { organizationId },
    });
    return this.view(organizationId, row);
  }

  async update(
    organizationId: string,
    input: BrandingInput & { expectedVersion: number },
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const values = normalizeBranding(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requireAccess(actor, organizationId, [BRANDING_MANAGE], tx);
        await advisoryLock(tx, `organization-branding:${organizationId}`);
        const current = await tx.organizationBranding.findUnique({
          where: { organizationId },
        });
        const currentVersion = current?.version ?? 0;
        if (input.expectedVersion !== currentVersion)
          throw versionConflict(currentVersion);
        const changedFields = changedBrandingFields(valuesOf(current), values);
        let row: OrganizationBranding;
        if (current) {
          const updated = await tx.organizationBranding.updateMany({
            where: { id: current.id, version: currentVersion },
            data: {
              ...values,
              version: currentVersion + 1,
              updatedByUserId: actor,
            },
          });
          if (updated.count !== 1) throw versionConflict(currentVersion + 1);
          row = await tx.organizationBranding.findUniqueOrThrow({
            where: { id: current.id },
          });
        } else {
          row = await tx.organizationBranding.create({
            data: { organizationId, ...values, updatedByUserId: actor },
          });
        }
        await this.audit.write(
          {
            action: 'ORGANIZATION_BRANDING_UPDATED',
            entityType: 'OrganizationBranding',
            entityId: row.id,
            actorUserId: actor,
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ?? null,
            correlationId: context.correlationId ?? null,
            // Field names and flags only: never URLs, colors, text or emails.
            metadata: {
              organizationId,
              changedFields,
              version: row.version,
              created: !current,
              publicLoginEnabled: row.publicLoginEnabled,
            },
          },
          tx,
        );
        return this.view(organizationId, row);
      });
    } catch (error) {
      // Two first writes raced: the loser is a version conflict.
      if (isUniqueViolation(error)) throw versionConflict(1);
      throw error;
    }
  }

  /**
   * The unauthenticated login-page branding. Reads only organizations that opted in
   * (publicLoginEnabled) and returns only the public fields; anything else — unknown code,
   * archived or not opted in, several organizations — is the generic default.
   */
  async publicBranding(code: string | undefined): Promise<PublicBranding> {
    const select = {
      name: true,
      archivedAt: true,
      branding: {
        select: {
          displayName: true,
          shortName: true,
          loginLogoUrl: true,
          iconUrl: true,
          primaryColor: true,
          secondaryColor: true,
          loginSubtitle: true,
          websiteUrl: true,
          supportEmail: true,
          publicLoginEnabled: true,
        },
      },
    } as const;
    const byCode = code
      ? await this.prisma.organization.findUnique({
          where: { code },
          select,
        })
      : null;
    const active = await this.prisma.organization.findMany({
      where: { archivedAt: null },
      select,
      orderBy: { id: 'asc' },
      take: 2,
    });
    return resolvePublicBranding({ byCode, active });
  }
}
