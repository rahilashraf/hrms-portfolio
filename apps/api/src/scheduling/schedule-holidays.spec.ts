import { describe, expect, it } from 'vitest';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import {
  holidaysForAssignments,
  holidaysForViews,
  type HolidayCandidate,
} from './schedule-holidays.js';

const ORG = 'org-a';
const holiday = (
  id: string,
  date: string,
  scope: Partial<
    Pick<
      HolidayCandidate,
      'organizationalUnitId' | 'departmentId' | 'teamId' | 'organizationId'
    >
  > = {},
): HolidayCandidate => ({
  id,
  organizationId: ORG,
  organizationalUnitId: null,
  departmentId: null,
  teamId: null,
  date: new Date(`${date}T00:00:00.000Z`),
  name: id,
  kind: 'STATUTORY_HOLIDAY',
  ...scope,
});

// Unit paths run from the unit itself up to the root.
const unitChild: AuthorizationTarget = {
  type: 'ORGANIZATIONAL_UNIT',
  organizationId: ORG,
  unitPathIds: ['child', 'root'],
};
const deptInChild: AuthorizationTarget = {
  type: 'DEPARTMENT',
  organizationId: ORG,
  unitPathIds: ['child', 'root'],
  departmentId: 'dept-1',
};
const teamInDept: AuthorizationTarget = {
  type: 'TEAM',
  organizationId: ORG,
  unitPathIds: ['child', 'root'],
  departmentId: 'dept-1',
  teamId: 'team-1',
};
const otherDept: AuthorizationTarget = {
  type: 'DEPARTMENT',
  organizationId: ORG,
  unitPathIds: ['sibling', 'root'],
  departmentId: 'dept-2',
};

describe('schedule holiday markers (R4-A.6)', () => {
  const holidays = [
    holiday('org-wide', '2027-03-01'),
    holiday('root-unit', '2027-03-02', { organizationalUnitId: 'root' }),
    holiday('child-unit', '2027-03-03', { organizationalUnitId: 'child' }),
    holiday('dept-1', '2027-03-04', { departmentId: 'dept-1' }),
    holiday('team-1', '2027-03-05', { teamId: 'team-1' }),
    holiday('dept-2', '2027-03-06', { departmentId: 'dept-2' }),
    holiday('other-org', '2027-03-01', { organizationId: 'org-b' }),
  ];
  const targets = new Map<string, AuthorizationTarget | null>([
    [
      'root-unit',
      {
        type: 'ORGANIZATIONAL_UNIT',
        organizationId: ORG,
        unitPathIds: ['root'],
      },
    ],
    ['child-unit', unitChild],
    ['dept-1', deptInChild],
    ['team-1', teamInDept],
    ['dept-2', otherDept],
  ]);
  const visible = (views: AuthorizationTarget[]) =>
    holidaysForViews(holidays, targets, views).map((m) => m.name);

  it('shows an organization-wide view every holiday of its organization only', () => {
    expect(visible([{ type: 'ORGANIZATION', organizationId: ORG }])).toEqual([
      'org-wide',
      'root-unit',
      'child-unit',
      'dept-1',
      'team-1',
      'dept-2',
    ]);
  });

  it('shows a unit view the holidays that apply to it and those inside it, not a sibling’s', () => {
    expect(visible([unitChild])).toEqual([
      'org-wide',
      'root-unit',
      'child-unit',
      'dept-1',
      'team-1',
    ]);
  });

  it('shows a team view only what applies to the team', () => {
    expect(visible([teamInDept])).toEqual([
      'org-wide',
      'root-unit',
      'child-unit',
      'dept-1',
      'team-1',
    ]);
    expect(visible([otherDept])).toEqual(['org-wide', 'root-unit', 'dept-2']);
    expect(visible([])).toEqual([]);
  });

  it('marks an assignment’s holidays only on dates the assignment covers, date-only', () => {
    const markers = holidaysForAssignments(holidays, [
      {
        startDate: new Date('2027-03-03T00:00:00.000Z'),
        endDate: new Date('2027-03-05T00:00:00.000Z'),
        target: teamInDept,
      },
    ]);
    expect(markers).toEqual([
      {
        date: '2027-03-03',
        name: 'child-unit',
        kind: 'STATUTORY_HOLIDAY',
        organizationId: ORG,
      },
      {
        date: '2027-03-04',
        name: 'dept-1',
        kind: 'STATUTORY_HOLIDAY',
        organizationId: ORG,
      },
      {
        date: '2027-03-05',
        name: 'team-1',
        kind: 'STATUTORY_HOLIDAY',
        organizationId: ORG,
      },
    ]);
  });
});
