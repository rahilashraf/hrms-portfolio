import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  accountOrganizationsOf,
  auditOrganizationOf,
} from './audit-organization.js';

export type CreateAuditLogInput = Pick<
  Prisma.AuditLogUncheckedCreateInput,
  | 'action'
  | 'actorUserId'
  | 'entityType'
  | 'entityId'
  | 'ipAddress'
  | 'userAgent'
  | 'correlationId'
  | 'metadata'
  | 'occurredAt'
>;

type AuditClient = Pick<Prisma.TransactionClient, 'auditLog'> &
  Partial<Pick<Prisma.TransactionClient, '$queryRaw'>>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an audit entry. Phase 19: an entry without `metadata.organizationId` whose entity
   * type belongs to one organization is tagged with it (resolved in the same transaction), so
   * the audit viewer and audit retention see every module's entries.
   */
  /**
   * Batch 2: writes one entry per given organization, each tagged with it, or one untagged entry
   * (the System view) for an empty list — for writers that know exactly where an event belongs
   * (e.g. an administrator's action on a login, visible only where their authority applied).
   * No automatic tagging applies.
   */
  async writeForOrganizations(
    input: CreateAuditLogInput,
    organizationIds: readonly string[],
    client: AuditClient = this.prisma,
  ) {
    const metadata = { ...((input.metadata ?? {}) as Prisma.JsonObject) };
    delete metadata.organizationId;
    if (organizationIds.length === 0)
      return client.auditLog.create({ data: { ...input, metadata } });
    let first: Awaited<ReturnType<AuditClient['auditLog']['create']>> | null =
      null;
    for (const organizationId of [...new Set(organizationIds)].sort()) {
      const created = await client.auditLog.create({
        data: { ...input, metadata: { ...metadata, organizationId } },
      });
      first ??= created;
    }
    return first!;
  }

  async write(input: CreateAuditLogInput, client: AuditClient = this.prisma) {
    // Batch 2: an entry about an account is written once per organization of the account
    // (each copy tagged), or once untagged when it has none (audit-organization.ts).
    const accountOrganizations = await accountOrganizationsOf(client, input);
    if (accountOrganizations) {
      if (accountOrganizations.length === 0)
        return client.auditLog.create({ data: input });
      let first: Awaited<ReturnType<AuditClient['auditLog']['create']>> | null =
        null;
      for (const organizationId of accountOrganizations) {
        const created = await client.auditLog.create({
          data: {
            ...input,
            metadata: {
              ...((input.metadata ?? {}) as Prisma.JsonObject),
              organizationId,
            },
          },
        });
        first ??= created;
      }
      return first!;
    }
    const organizationId = await auditOrganizationOf(client, input);
    const data = organizationId
      ? {
          ...input,
          metadata: {
            ...((input.metadata ?? {}) as Prisma.JsonObject),
            organizationId,
          },
        }
      : input;
    return client.auditLog.create({ data });
  }
}
