import type { Prisma } from '../generated/prisma/client.js';

/** A policy layer's scope columns (any TimeAttendancePolicy row or selection of one). */
export interface PolicyScopeRow {
  id: string;
  scopeType: string;
  organizationId: string | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  employmentAssignmentId: string | null;
}

type Client = Pick<
  Prisma.TransactionClient,
  | 'organization'
  | 'organizationalUnit'
  | 'department'
  | 'team'
  | 'employmentAssignment'
>;

function personName(person: {
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
}) {
  return (
    [person.preferredName || person.firstName, person.lastName]
      .filter(Boolean)
      .join(' ') || 'Unnamed employee'
  );
}

/**
 * Batch 4E-2 (B2) — human-readable names of policy layers' scopes, by layer id: "System", the
 * organization, unit, department or team name, or "employee · position" for an assignment layer.
 * Callers pass only layers the reader may already see; this reads nothing else.
 */
export async function policyScopeNames(
  client: Client,
  rows: readonly PolicyScopeRow[],
): Promise<Map<string, string>> {
  const ids = (pick: (row: PolicyScopeRow) => string | null) => [
    ...new Set(rows.map(pick).filter((id): id is string => Boolean(id))),
  ];
  const [organizations, units, departments, teams, assignments] =
    await Promise.all([
      client.organization.findMany({
        where: { id: { in: ids((row) => row.organizationId) } },
        select: { id: true, name: true },
      }),
      client.organizationalUnit.findMany({
        where: { id: { in: ids((row) => row.organizationalUnitId) } },
        select: { id: true, name: true },
      }),
      client.department.findMany({
        where: { id: { in: ids((row) => row.departmentId) } },
        select: { id: true, name: true },
      }),
      client.team.findMany({
        where: { id: { in: ids((row) => row.teamId) } },
        select: { id: true, name: true },
      }),
      client.employmentAssignment.findMany({
        where: { id: { in: ids((row) => row.employmentAssignmentId) } },
        select: {
          id: true,
          position: { select: { name: true } },
          employee: {
            select: {
              person: {
                select: {
                  firstName: true,
                  lastName: true,
                  preferredName: true,
                },
              },
            },
          },
        },
      }),
    ]);
  const byId = (list: Array<{ id: string; name: string }>) =>
    new Map(list.map((item) => [item.id, item.name]));
  const organizationNames = byId(organizations);
  const unitNames = byId(units);
  const departmentNames = byId(departments);
  const teamNames = byId(teams);
  const assignmentNames = new Map(
    assignments.map((assignment) => [
      assignment.id,
      `${personName(assignment.employee.person)} · ${assignment.position.name}`,
    ]),
  );
  const names = new Map<string, string>();
  for (const row of rows) {
    const name =
      row.scopeType === 'SYSTEM'
        ? 'System'
        : row.scopeType === 'ORGANIZATION'
          ? organizationNames.get(row.organizationId ?? '')
          : row.scopeType === 'ORGANIZATIONAL_UNIT'
            ? unitNames.get(row.organizationalUnitId ?? '')
            : row.scopeType === 'DEPARTMENT'
              ? departmentNames.get(row.departmentId ?? '')
              : row.scopeType === 'TEAM'
                ? teamNames.get(row.teamId ?? '')
                : assignmentNames.get(row.employmentAssignmentId ?? '');
    names.set(row.id, name ?? 'Unknown');
  }
  return names;
}
