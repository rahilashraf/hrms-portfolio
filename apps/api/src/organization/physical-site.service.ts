import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { advisoryLock, domainError } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PhysicalSiteCreateDto,
  PhysicalSiteUpdateDto,
} from './organization.dto.js';
import type { RequestAuditContext } from './organization.service.js';

type Tx = Prisma.TransactionClient;

const ADDRESS_FIELDS = [
  'addressLine1',
  'addressLine2',
  'city',
  'stateProvince',
  'postalCode',
  'country',
] as const;

/**
 * Batch 5B (D12) — physical sites of an organization: the buildings work locations and kiosk
 * devices belong to. Organization-scoped: reading needs organization.read or
 * organization.manage (or time.device.manage, which picks a site for a kiosk) in the
 * organization; changes need organization.manage there. An organization the caller cannot see
 * answers 404; visible but read-only answers 403. Every change is audited with before/after.
 * Nothing is ever deleted: archive refuses a site an unarchived work location or an active kiosk
 * still uses, and reactivation brings it back.
 */
@Injectable()
export class PhysicalSiteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(
    organizationId: string,
    actorUserId: string,
    includeArchived = false,
  ) {
    await this.requireReadable(organizationId, actorUserId);
    const sites = await this.prisma.physicalSite.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        _count: {
          select: {
            workLocations: { where: { archivedAt: null } },
            attendanceDevices: { where: { status: 'ACTIVE' } },
          },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: sites.map(({ _count, ...site }) => ({
        ...site,
        activeWorkLocations: _count.workLocations,
        activeDevices: _count.attendanceDevices,
      })),
    };
  }

  async get(organizationId: string, id: string, actorUserId: string) {
    await this.requireReadable(organizationId, actorUserId);
    return this.requireSite(this.prisma, organizationId, id);
  }

  async create(
    organizationId: string,
    input: PhysicalSiteCreateDto,
    context: RequestAuditContext,
  ) {
    const actor = await this.requireManager(organizationId, context);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, organizationId);
      await this.requireLiveOrganization(tx, organizationId);
      const data = {
        organizationId,
        name: this.name(input.name),
        ...this.address(input),
      };
      await this.assertNameFree(tx, organizationId, data.name, null);
      const site = await tx.physicalSite.create({ data });
      await this.writeAudit(tx, 'PHYSICAL_SITE_CREATED', site.id, context, {
        organizationId,
        before: null,
        after: site,
        actor,
      });
      return site;
    });
  }

  async update(
    organizationId: string,
    id: string,
    input: PhysicalSiteUpdateDto,
    context: RequestAuditContext,
  ) {
    await this.requireManager(organizationId, context);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, organizationId);
      await this.requireLiveOrganization(tx, organizationId);
      const current = await this.requireSite(tx, organizationId, id);
      if (current.archivedAt)
        throw new ConflictException(
          domainError(
            409,
            'PHYSICAL_SITE_ARCHIVED',
            'Reactivate the physical site before changing it.',
          ),
        );
      const updates: Record<string, string | null> = {};
      if (input.name !== undefined) updates.name = this.name(input.name);
      for (const field of ADDRESS_FIELDS) {
        if (input[field] !== undefined)
          updates[field] = this.optional(input[field]);
      }
      if (Object.keys(updates).length === 0) return current;
      if (updates.name !== undefined && updates.name !== current.name)
        await this.assertNameFree(tx, organizationId, updates.name!, id);
      const next = await tx.physicalSite.update({
        where: { id },
        data: updates,
      });
      await this.writeAudit(tx, 'PHYSICAL_SITE_UPDATED', id, context, {
        organizationId,
        before: current,
        after: next,
        changedFields: Object.keys(updates).sort(),
      });
      return next;
    });
  }

  async archive(
    organizationId: string,
    id: string,
    context: RequestAuditContext,
  ) {
    await this.requireManager(organizationId, context);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, organizationId);
      const current = await this.requireSite(tx, organizationId, id);
      if (current.archivedAt) return current;
      const [workLocations, devices] = await Promise.all([
        tx.workLocation.count({
          where: { physicalSiteId: id, archivedAt: null },
        }),
        tx.attendanceDevice.count({
          where: { physicalSiteId: id, status: 'ACTIVE' },
        }),
      ]);
      if (workLocations > 0 || devices > 0)
        throw new ConflictException(
          domainError(
            409,
            'PHYSICAL_SITE_IN_USE',
            'This physical site still has work locations or active kiosk devices; move or archive them first.',
            { activeWorkLocations: workLocations, activeDevices: devices },
          ),
        );
      const next = await tx.physicalSite.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'PHYSICAL_SITE_ARCHIVED', id, context, {
        organizationId,
        before: current,
        after: next,
      });
      return next;
    });
  }

  async reactivate(
    organizationId: string,
    id: string,
    context: RequestAuditContext,
  ) {
    await this.requireManager(organizationId, context);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, organizationId);
      await this.requireLiveOrganization(tx, organizationId);
      const current = await this.requireSite(tx, organizationId, id);
      if (!current.archivedAt) return current;
      await this.assertNameFree(tx, organizationId, current.name, id);
      const next = await tx.physicalSite.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(tx, 'PHYSICAL_SITE_REACTIVATED', id, context, {
        organizationId,
        before: current,
        after: next,
      });
      return next;
    });
  }

  /** A site created for a work location that has none (an explicit, audited creation). */
  async createForWorkLocation(
    tx: Tx,
    organizationId: string,
    source: {
      name: string;
      addressLine1?: string | null;
      addressLine2?: string | null;
      city?: string | null;
      stateProvince?: string | null;
      postalCode?: string | null;
      country?: string | null;
    },
    context: RequestAuditContext,
  ) {
    const site = await tx.physicalSite.create({
      data: {
        organizationId,
        name: source.name,
        addressLine1: source.addressLine1 ?? null,
        addressLine2: source.addressLine2 ?? null,
        city: source.city ?? null,
        stateProvince: source.stateProvince ?? null,
        postalCode: source.postalCode ?? null,
        country: source.country ?? null,
      },
    });
    await this.writeAudit(tx, 'PHYSICAL_SITE_CREATED', site.id, context, {
      organizationId,
      before: null,
      after: site,
      source: 'WORK_LOCATION',
    });
    return site;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private lock(tx: Tx, organizationId: string) {
    // The organization's structure lock (work locations, positions, units take it too).
    return advisoryLock(tx, `organization-structure:${organizationId}`);
  }

  private async requireReadable(organizationId: string, actorUserId: string) {
    const scope = { type: 'ORGANIZATION' as const, id: organizationId };
    const exists = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Organization not found');
    for (const permission of [
      'organization.read',
      'organization.manage',
      'time.device.manage',
    ]) {
      if (await this.authorization.canAccess(actorUserId, permission, scope))
        return;
    }
    throw new NotFoundException('Organization not found');
  }

  private async requireManager(
    organizationId: string,
    context: RequestAuditContext,
  ) {
    const actor = context.actorUserId;
    if (!actor) throw new ForbiddenException();
    await this.requireReadable(organizationId, actor);
    if (
      !(await this.authorization.canAccess(actor, 'organization.manage', {
        type: 'ORGANIZATION',
        id: organizationId,
      }))
    )
      throw new ForbiddenException(
        'Managing physical sites needs organization.manage in this organization.',
      );
    return actor;
  }

  private async requireLiveOrganization(tx: Tx, organizationId: string) {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { archivedAt: true },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    if (organization.archivedAt)
      throw new ConflictException(
        domainError(
          409,
          'ORGANIZATION_ARCHIVED',
          'The organization is archived.',
        ),
      );
  }

  private async requireSite(
    client: Tx | PrismaService,
    organizationId: string,
    id: string,
  ) {
    const site = await client.physicalSite.findFirst({
      where: { id, organizationId },
    });
    if (!site) throw new NotFoundException('Physical site not found');
    return site;
  }

  private async assertNameFree(
    tx: Tx,
    organizationId: string,
    name: string,
    exceptId: string | null,
  ) {
    const clash = await tx.physicalSite.findFirst({
      where: {
        organizationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(
        domainError(
          409,
          'PHYSICAL_SITE_NAME_TAKEN',
          'Another active physical site of this organization has that name.',
        ),
      );
  }

  private name(value: string) {
    return value.trim();
  }

  private optional(value: string | null | undefined) {
    if (value === null || value === undefined) return null;
    return value.trim() || null;
  }

  private address(
    input: Partial<Record<(typeof ADDRESS_FIELDS)[number], string | null>>,
  ) {
    return Object.fromEntries(
      ADDRESS_FIELDS.map((field) => [field, this.optional(input[field])]),
    ) as Record<(typeof ADDRESS_FIELDS)[number], string | null>;
  }

  private async writeAudit(
    tx: Tx,
    action: string,
    entityId: string,
    context: RequestAuditContext,
    metadata: Record<string, unknown>,
  ) {
    const { actor: _actor, ...rest } = metadata;
    void _actor;
    await this.audit.write(
      {
        action,
        actorUserId: context.actorUserId ?? null,
        entityType: 'PhysicalSite',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(rest)) as Prisma.InputJsonValue,
      },
      tx,
    );
  }
}
