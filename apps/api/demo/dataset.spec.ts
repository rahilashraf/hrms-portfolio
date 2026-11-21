import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIFECYCLE_UPCOMING_DEFAULT_DAYS } from '../src/employee/employee.dto.js';
import {
  CANDIDATES,
  CLOCK_POLICY,
  DEMO_ACCOUNTS,
  DEPARTMENTS,
  EMPLOYEES,
  EXTRA_ASSIGNMENTS,
  OPERATIONS_TEAMS,
  POSITIONS,
  SCHEDULED_TERMINATION,
  SEASONAL_EMPLOYEE,
  STRUCTURE_ROLES,
} from './dataset.js';
import { DEMO_EMAIL_DOMAIN } from './demo-database.js';
import { localToday } from './scenarios.js';
import { addDays } from './workflows.js';

/**
 * R5-A — invariants of the demonstration scenarios (lifecycle panel, multi-assignment clock-in,
 * scoped structure management). Offsets are days from the reference Monday; a demo is first
 * seeded during the reference week, so "today" at first seed is offset 0 to 6.
 */
const FIRST_SEED_LATEST_OFFSET = 6;
const here = dirname(fileURLToPath(import.meta.url));
const scenarioSource = readFileSync(resolve(here, 'scenarios.ts'), 'utf8');

const employee = (number: string) => {
  const found = EMPLOYEES.find((candidate) => candidate.number === number);
  if (!found) throw new Error(`No demo employee ${number}`);
  return found;
};

describe('demo accounts', () => {
  it('uses only the reserved demo domain, with unique keys and addresses', () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(account.email.endsWith(DEMO_EMAIL_DOMAIN)).toBe(true);
    }
    for (const candidate of CANDIDATES) {
      expect(candidate.email.endsWith(DEMO_EMAIL_DOMAIN)).toBe(true);
    }
    expect(new Set(DEMO_ACCOUNTS.map((a) => a.key)).size).toBe(
      DEMO_ACCOUNTS.length,
    );
    expect(new Set(DEMO_ACCOUNTS.map((a) => a.email)).size).toBe(
      DEMO_ACCOUNTS.length,
    );
  });

  it('links the facilities coordinator account to exactly one Operations employee', () => {
    const account = DEMO_ACCOUNTS.find((a) => a.key === 'facilities');
    expect(account?.email).toBe(`facilities${DEMO_EMAIL_DOMAIN}`);
    const linked = EMPLOYEES.filter((e) => e.account === 'facilities');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      organization: 'centre',
      department: 'OPS',
      firstName: account!.firstName,
      lastName: account!.lastName,
    });
  });
});

describe('scoped structure management', () => {
  const manage = STRUCTURE_ROLES.filter((role) =>
    role.permissions.includes('organization.manage'),
  );

  it('grants organization.manage only below the organization (one department)', () => {
    expect(manage.length).toBeGreaterThan(0);
    for (const role of manage) {
      expect(role.scope?.type).toBe('DEPARTMENT');
      const department =
        role.scope?.type === 'DEPARTMENT' ? role.scope.department : '';
      expect(DEPARTMENTS.centre.map((d) => d.code)).toContain(department);
    }
  });

  it('gives organization-wide scope to read-only permissions at most', () => {
    for (const role of STRUCTURE_ROLES) {
      if (role.scope === undefined || role.scope.type === 'ORGANIZATION') {
        expect(role.permissions).toEqual(['organization.read']);
      }
    }
  });

  it('is held by the facilities coordinator only', () => {
    for (const role of STRUCTURE_ROLES) {
      expect(role.holders).toEqual(['facilities']);
    }
  });

  it('has teams to manage, created by the scoped account itself', () => {
    expect(OPERATIONS_TEAMS.length).toBeGreaterThanOrEqual(2);
    expect(scenarioSource).toContain("world.session('facilities')");
  });
});

describe('extra assignments', () => {
  const existingPositionCodes = new Set(
    EMPLOYEES.map((e) => `${e.position}-${e.number.slice(3)}`),
  );

  it('uses new, distinct positions and job titles for existing employees', () => {
    const codes = EXTRA_ASSIGNMENTS.map((a) => a.positionCode);
    expect(new Set(codes).size).toBe(codes.length);
    const titles = new Set(POSITIONS.centre.map((p) => p.code));
    for (const spec of EXTRA_ASSIGNMENTS) {
      expect(existingPositionCodes.has(spec.positionCode)).toBe(false);
      expect(titles.has(spec.jobTitle.code)).toBe(false);
      expect(employee(spec.employee).organization).toBe('centre');
      expect(DEPARTMENTS.centre.map((d) => d.code)).toContain(spec.department);
    }
  });

  it('gives the self-service employee a second, open-ended assignment in her own organization', () => {
    const sofia = employee('HL-1005');
    expect(sofia.account).toBe('employee');
    const second = EXTRA_ASSIGNMENTS.filter((a) => a.employee === 'HL-1005');
    expect(second).toHaveLength(1);
    expect(employee(second[0]!.employee).organization).toBe(sofia.organization);
    // Starts after the completed (finalized) pay periods, and stays open for clocking.
    expect(second[0]!.startOffset).toBeGreaterThanOrEqual(0);
    expect(second[0]!.endOffset).toBeNull();
    // The live-clock policy covers both of her assignments' department.
    expect(second[0]!.department).toBe(sofia.department);
    expect(CLOCK_POLICY.department).toBe(sofia.department);
    expect(CLOCK_POLICY.config.clock.mode).toBe('LIVE_CLOCK');
  });

  it('never makes an extra assignment primary, and never adds pay or time', () => {
    expect(scenarioSource).toContain('isPrimary: false');
    expect(scenarioSource).not.toMatch(
      /\/compensation|\/time\/(me|employees|clock-in)/,
    );
  });

  it('produces one past and one upcoming assignment end relative to the reference date', () => {
    const reference = '2026-11-16';
    const past = EXTRA_ASSIGNMENTS.filter(
      (a) => a.endOffset !== null && a.endOffset < 0,
    );
    const upcoming = EXTRA_ASSIGNMENTS.filter(
      (a) => a.endOffset !== null && a.endOffset >= 0,
    );
    expect(past).toHaveLength(1);
    expect(upcoming).toHaveLength(1);
    // A past end can only be recorded on an ACTIVE assignment by the correction.
    expect(past[0]!.endVia).toBe('correct');
    expect(addDays(reference, past[0]!.endOffset!) < reference).toBe(true);
    // Upcoming in the panel's default window whichever day of the reference week it is seeded.
    expect(upcoming[0]!.endVia).toBe('create');
    expect(upcoming[0]!.endOffset!).toBeGreaterThan(FIRST_SEED_LATEST_OFFSET);
    expect(upcoming[0]!.endOffset!).toBeLessThanOrEqual(
      LIFECYCLE_UPCOMING_DEFAULT_DAYS,
    );
    for (const spec of [...past, ...upcoming]) {
      expect(spec.startOffset).toBeLessThanOrEqual(spec.endOffset!);
    }
  });
});

describe('scheduled termination', () => {
  it('targets a new, non-account seasonal hire who is in no payroll run', () => {
    expect(SCHEDULED_TERMINATION.employee).toBe(SEASONAL_EMPLOYEE.number);
    expect(SEASONAL_EMPLOYEE.organization).toBe('centre');
    // Not in EMPLOYEES: the operational seed gives every listed employee compensation (and so a
    // place in a pay group's runs); the seasonal hire gets none, and no account.
    expect(EMPLOYEES.some((e) => e.number === SEASONAL_EMPLOYEE.number)).toBe(
      false,
    );
    expect(
      DEMO_ACCOUNTS.some(
        (a) =>
          a.firstName === SEASONAL_EMPLOYEE.firstName &&
          a.lastName === SEASONAL_EMPLOYEE.lastName,
      ),
    ).toBe(false);
    expect(
      EXTRA_ASSIGNMENTS.some((a) => a.employee === SEASONAL_EMPLOYEE.number),
    ).toBe(false);
    // Hired on or after the reference date: after every completed (calculated or finalized) period.
    expect(SEASONAL_EMPLOYEE.hireOffset).toBeGreaterThanOrEqual(0);
    expect(SEASONAL_EMPLOYEE.hireOffset).toBeLessThan(
      SCHEDULED_TERMINATION.dateOffset,
    );
    const usedPositions = new Set([
      ...EMPLOYEES.map((e) => `${e.position}-${e.number.slice(3)}`),
      ...EXTRA_ASSIGNMENTS.map((a) => a.positionCode),
    ]);
    expect(usedPositions.has(SEASONAL_EMPLOYEE.positionCode)).toBe(false);
    expect(DEPARTMENTS.centre.map((d) => d.code)).toContain(
      SEASONAL_EMPLOYEE.department,
    );
  });

  it('leaves every existing (paid) employee untouched', () => {
    for (const e of EMPLOYEES)
      expect(SCHEDULED_TERMINATION.employee).not.toBe(e.number);
  });

  it('is in the future at first seed and inside the default upcoming window', () => {
    expect(SCHEDULED_TERMINATION.dateOffset).toBeGreaterThan(
      FIRST_SEED_LATEST_OFFSET,
    );
    expect(SCHEDULED_TERMINATION.dateOffset).toBeLessThanOrEqual(
      LIFECYCLE_UPCOMING_DEFAULT_DAYS,
    );
  });

  it('is only ever scheduled: the seed never applies a termination or an assignment end', () => {
    expect(scenarioSource).toContain('/terminate`');
    expect(scenarioSource).not.toMatch(/\/apply|apply-end|\/end`/);
    // A date that is no longer in the future is skipped (the API would apply it at once).
    expect(scenarioSource).toContain('terminationDate <= today');
  });
});

describe('localToday', () => {
  it('formats the date in the given time zone', () => {
    const instant = new Date('2026-11-17T03:00:00Z');
    expect(localToday('America/Toronto', instant)).toBe('2026-11-16');
    expect(localToday('Asia/Kolkata', instant)).toBe('2026-11-17');
  });
});
