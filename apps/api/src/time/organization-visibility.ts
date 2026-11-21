import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

type Client = Prisma.TransactionClient | PrismaClient;

/**
 * The organizations in which a user holds at least one of the given permissions, from any
 * scope (organization, unit, department or team): 'ALL' for a SYSTEM grant, null for none.
 *
 * Batch 4B / 4F: a record of an organization the caller cannot see at all is answered 404,
 * exactly as if it did not exist, so its existence is never revealed across organizations.
 * Within an organization the caller works in, a record outside their scope stays 403.
 */
export async function grantOrganizations(
  authorization: AuthorizationService,
  userId: string,
  permissions: readonly string[],
  client: Client,
): Promise<'ALL' | string[] | null> {
  const grants = (
    await authorization.effectiveGrants(
      userId,
      new Date(),
      client as Prisma.TransactionClient,
    )
  ).filter((grant) => permissions.includes(grant.permission));
  if (grants.length === 0) return null;
  if (grants.some((grant) => grant.scope.type === 'SYSTEM')) return 'ALL';
  const ids = (type: string) =>
    grants
      .filter((grant) => grant.scope.type === type && grant.scope.id)
      .map((grant) => grant.scope.id!);
  const [units, departments, teams] = await Promise.all([
    client.organizationalUnit.findMany({
      where: { id: { in: ids('ORGANIZATIONAL_UNIT') } },
      select: { organizationId: true },
    }),
    client.department.findMany({
      where: { id: { in: ids('DEPARTMENT') } },
      select: { organizationId: true },
    }),
    client.team.findMany({
      where: { id: { in: ids('TEAM') } },
      select: { organizationId: true },
    }),
  ]);
  const organizations = [
    ...new Set([
      ...ids('ORGANIZATION'),
      ...[...units, ...departments, ...teams].map((row) => row.organizationId),
    ]),
  ];
  return organizations.length > 0 ? organizations : null;
}

/** Whether the user can see records of the organization at all (see grantOrganizations). */
export async function canSeeOrganization(
  authorization: AuthorizationService,
  userId: string,
  organizationIds: readonly string[],
  permissions: readonly string[],
  client: Client,
): Promise<boolean> {
  const visible = await grantOrganizations(
    authorization,
    userId,
    permissions,
    client,
  );
  if (visible === 'ALL') return true;
  if (!visible) return false;
  return organizationIds.some((id) => visible.includes(id));
}
