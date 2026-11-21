import { describe, expect, it } from 'vitest';
import {
  additionalCoverage,
  coveredAssignments,
  MAX_COVERED_ASSIGNMENTS,
  sameAssignmentSet,
  secondaryCoverageIds,
} from './time-coverage.js';

const row = (id: string, removed = false) => ({
  employmentAssignmentId: id,
  removedAt: removed ? new Date('2027-03-02T12:00:00.000Z') : null,
  employmentAssignment: { id },
});

describe('multi-assignment coverage rules', () => {
  it('normalizes requested additional coverage: no owner, no duplicates, bounded', () => {
    expect(additionalCoverage('a', undefined)).toEqual([]);
    expect(additionalCoverage('a', ['b', 'a', 'c', 'b'])).toEqual(['b', 'c']);
    const tooMany = Array.from(
      { length: MAX_COVERED_ASSIGNMENTS },
      (_, i) => `x${i}`,
    );
    expect(() => additionalCoverage('a', tooMany)).toThrow('at most');
    expect(additionalCoverage('a', tooMany.slice(1))).toHaveLength(
      MAX_COVERED_ASSIGNMENTS - 1,
    );
  });

  it('lists the payroll owner first, even for an entry without coverage rows', () => {
    expect(
      coveredAssignments({
        employmentAssignmentId: 'a',
        employmentAssignment: { id: 'a' },
      }),
    ).toEqual([
      {
        employmentAssignmentId: 'a',
        assignment: { id: 'a' },
        isPayrollOwner: true,
      },
    ]);
    expect(
      coveredAssignments({
        employmentAssignmentId: 'b',
        employmentAssignment: { id: 'b' },
        assignmentCoverages: [row('a', true), row('c'), row('b'), row('c')],
      }).map((covered) => [
        covered.employmentAssignmentId,
        covered.isPayrollOwner,
      ]),
    ).toEqual([
      ['b', true],
      ['c', false],
    ]);
  });

  it('compares secondary coverage as sets', () => {
    const entry = {
      employmentAssignmentId: 'a',
      assignmentCoverages: [row('a'), row('b'), row('c', true), row('d')],
    };
    expect(secondaryCoverageIds(entry)).toEqual(['b', 'd']);
    expect(sameAssignmentSet(['d', 'b'], secondaryCoverageIds(entry))).toBe(
      true,
    );
    expect(sameAssignmentSet(['b'], secondaryCoverageIds(entry))).toBe(false);
    expect(sameAssignmentSet([], [])).toBe(true);
  });
});
