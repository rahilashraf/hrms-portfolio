import { Injectable } from '@nestjs/common';
import { pageBy } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import { DocumentsAccessService } from './documents-access.service.js';

export const DOCUMENT_OPTION_KINDS = ['department', 'position'] as const;
export type DocumentOptionKind = (typeof DOCUMENT_OPTION_KINDS)[number];

export interface DocumentOptionQuery {
  organizationId: string;
  kind: DocumentOptionKind;
  search?: string;
  limit?: number;
  afterId?: string;
}

const MAX_LIMIT = 50;

/**
 * Batch 9 (F5) — read-only pickers for requirement criteria and policy audiences, so document
 * type and policy managers never type raw ids nor need organization.read: the organization's
 * active departments and positions (ids, names and codes only), for document.type.manage or
 * document.policy.manage at the organization, with Documents enabled there; paged by id.
 */
@Injectable()
export class DocumentOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentsAccessService,
  ) {}

  async options(userId: string, query: DocumentOptionQuery) {
    const grants = await this.access.grants(userId);
    const allowed =
      this.access.canInOrganization(
        grants,
        'document.type.manage',
        query.organizationId,
      ) ||
      this.access.canInOrganization(
        grants,
        'document.policy.manage',
        query.organizationId,
      );
    if (!allowed) {
      await this.access.requireOrganization(
        userId,
        'document.type.manage',
        query.organizationId,
      );
    }
    await this.access.requireEnabled(query.organizationId);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), MAX_LIMIT);
    const search = query.search?.trim();
    const s = search
      ? { contains: search, mode: 'insensitive' as const }
      : undefined;
    const model =
      query.kind === 'department'
        ? this.prisma.department
        : this.prisma.position;
    return pageBy<{ id: string; label: string; description?: string }>(
      limit,
      query.afterId,
      async (cursor, take) => {
        const rows = await (
          model as unknown as {
            findMany(
              args: unknown,
            ): Promise<
              Array<{ id: string; name: string; code: string | null }>
            >;
          }
        ).findMany({
          where: {
            organizationId: query.organizationId,
            archivedAt: null,
            ...(cursor ? { id: { gt: cursor } } : {}),
            ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
          },
          select: { id: true, name: true, code: true },
          orderBy: { id: 'asc' },
          take,
        });
        return rows.map((row) => ({
          id: row.id,
          option: {
            id: row.id,
            label: row.name,
            ...(row.code ? { description: row.code } : {}),
          },
        }));
      },
    );
  }
}
