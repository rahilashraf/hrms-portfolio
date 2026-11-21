import { documentsApi } from '../documents/api';
import { authorizationApi } from '../authorization/api';
import { compensationApi } from '../compensation/api';
import { employeeApi } from '../employee/api';
import type { EmployeeDirectoryItem, EmployeePersonSummary } from '../employee/types';
import { organizationApi } from '../organization/api';
import { recruitmentApi } from '../recruitment/api';
import type { RecordPage, RecordSource } from './use-record-search';

/**
 * Batch 3B — what a record picker shows for one record. Sources map their records to options so
 * the picker stays the same for every kind of record.
 */
export interface PickerOption {
  id: string;
  label: string;
  /** A second line: number, position, organization, email… */
  description?: string;
  /** Shown and not selectable when set (e.g. "Not activated yet"). */
  disabledReason?: string;
}

const PAGE = 20;

function personName(person: EmployeePersonSummary | null | undefined, fallback: string): string {
  if (!person) return fallback;
  return (
    person.preferredName ||
    [person.firstName, person.lastName].filter(Boolean).join(' ') ||
    fallback
  );
}

const joinParts = (...parts: Array<string | null | undefined>) =>
  parts.filter(Boolean).join(' · ') || undefined;

/** Employees the user may read (GET /employees: employee.read, checked per position). */
export function employeeSource(
  filters: { organizationId?: string; status?: 'ACTIVE' } = {},
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await employeeApi.list({
        ...(query ? { search: query } : {}),
        ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        limit: PAGE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return { items: page.items.map(employeeOption), next: page.nextAfterId };
    },
  };
}

export function employeeOption(item: EmployeeDirectoryItem): PickerOption {
  const assignment = item.displayAssignment;
  return {
    id: item.id,
    label: personName(item.person, 'Unnamed employee'),
    description: joinParts(
      item.employeeNumber,
      assignment?.position.name,
      assignment?.organization.name,
    ),
  };
}

/** Positions the user may staff (GET /employees/options/positions: employee.manage per position). */
export function positionSource(
  filters: { organizationId?: string } = {},
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await employeeApi.listPositionOptions({
        ...(query ? { search: query } : {}),
        ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
        limit: PAGE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return {
        items: page.items.map((position) => ({
          id: position.id,
          label: position.name,
          description: joinParts(position.code, position.jobTitle.name, position.organization.name),
        })),
        next: page.nextAfterId,
      };
    },
  };
}

/** Possible managers of one assignment (GET /employees/options/manager-assignments). */
export function managerAssignmentSource(
  subordinateAssignmentId: string,
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await employeeApi.listManagerAssignmentOptions({
        subordinateAssignmentId,
        ...(query ? { search: query } : {}),
        limit: PAGE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return {
        items: page.items.map((option) => ({
          id: option.assignmentId,
          label: option.displayName,
          description: joinParts(
            option.employeeNumber,
            option.position.name,
            option.organization.name,
          ),
        })),
        next: page.nextAfterId,
      };
    },
  };
}

/** People who may become employees (GET /employees/options/people: employee.manage at System). */
export function personSource(): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await employeeApi.listPersonOptions({
        ...(query ? { search: query } : {}),
        limit: PAGE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return {
        items: page.items.map((person) => ({
          id: person.id,
          label: personName(person, 'Unnamed person'),
          description: person.personalEmail ?? undefined,
          ...(person.hasEmployee ? { disabledReason: 'Already an employee' } : {}),
        })),
        next: page.nextAfterId,
      };
    },
  };
}

/**
 * Accounts connected to the organizations where the user manages access (GET /authorization/users:
 * role.assign; since #40 never other organizations' people). `activeOnly` shows invited accounts
 * as not selectable, for actions that need an active account.
 */
export function userSource(
  organizationId: string,
  { activeOnly = false }: { activeOnly?: boolean } = {},
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await authorizationApi.searchUsers(organizationId, query, cursor, PAGE);
      return {
        items: page.items.map((user) => ({
          id: user.id,
          label: user.displayName ?? user.email,
          description: joinParts(user.displayName ? user.email : null, user.employeeNumber),
          ...(activeOnly && user.status !== 'ACTIVE'
            ? { disabledReason: 'Not activated yet' }
            : {}),
        })),
        next: page.nextCursor,
      };
    },
  };
}

/**
 * Recruitment candidates (GET /recruitment/candidates; at most 200 per search, no cursor, so the
 * search narrows the list).
 */
export function candidateSource(
  organizationId: string,
  { excludeId }: { excludeId?: string } = {},
): RecordSource<PickerOption> {
  return {
    async search(query) {
      const result = await recruitmentApi.candidates(
        organizationId,
        query ? { search: query } : {},
      );
      return {
        items: result.items
          .filter((candidate) => candidate.id !== excludeId)
          .map((candidate) => ({
            id: candidate.id,
            label: candidate.displayName,
            description: joinParts(candidate.email ?? null, candidate.internal ? 'Internal' : null),
            ...(candidate.mergedIntoCandidateId ? { disabledReason: 'Merged' } : {}),
          })),
        next: null,
      };
    },
  };
}

/**
 * A short list loaded once (departments, teams, pay groups…) and filtered as the user types.
 * The load runs again only if it failed.
 */
export function listSource(load: () => Promise<PickerOption[]>): RecordSource<PickerOption> {
  let cached: Promise<PickerOption[]> | null = null;
  return {
    async search(query): Promise<RecordPage<PickerOption>> {
      cached ??= load().catch((error: unknown) => {
        cached = null;
        throw error;
      });
      const options = await cached;
      const term = query.trim().toLowerCase();
      return {
        items: term
          ? options.filter((option) =>
              `${option.label} ${option.description ?? ''}`.toLowerCase().includes(term),
            )
          : options,
        next: null,
      };
    },
  };
}

/**
 * An organization's units, departments, teams or positions (GET /organizations/:id/…: rows the
 * user may read with organization.read; not paged, so loaded once). Archived ones are left out.
 */
export function structureSource(
  organizationId: string,
  kind: 'units' | 'departments' | 'teams' | 'positions',
): RecordSource<PickerOption> {
  return listSource(async () => {
    const rows: Array<{ id: string; name: string; code?: string | null }> =
      kind === 'units'
        ? await organizationApi.listUnits(organizationId)
        : kind === 'departments'
          ? await organizationApi.listDepartments(organizationId)
          : kind === 'teams'
            ? await organizationApi.listTeams(organizationId)
            : await organizationApi.listPositions(organizationId);
    return rows.map((row) => ({ id: row.id, label: row.name, description: row.code ?? undefined }));
  });
}

/** An organization's active pay groups (GET /pay-groups: any compensation permission there). */
export function payGroupSource(organizationId: string): RecordSource<PickerOption> {
  return listSource(async () => {
    const result = await compensationApi.payGroups(organizationId);
    return result.items.map((group) => ({
      id: group.id,
      label: group.name,
      description: group.code,
    }));
  });
}

/**
 * Batch 9 (F5): departments or positions for document requirements and policy audiences
 * (GET /documents/options — document type or policy managers of the organization).
 */
export function documentStructureSource(
  organizationId: string,
  kind: 'department' | 'position',
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await documentsApi.options(organizationId, kind, {
        ...(query ? { search: query } : {}),
        limit: PAGE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return { items: page.items, next: page.nextAfterId };
    },
  };
}
