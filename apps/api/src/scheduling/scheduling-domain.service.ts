import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { assertIanaTimezone } from '../common/timezone.js';
import { EmployeeDomainService } from '../employee/employee-domain.service.js';
import {
  DEFAULT_CONFLICT_POLICY,
  type ConflictPolicy,
} from './schedule-policy.js';
import type {
  ScheduleConflictType,
  ScheduledShiftStatus,
  ScheduleScopeType,
} from '../generated/prisma/enums.js';

export interface AssignmentEffectivenessCheck {
  status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  startDate: Date;
  endDate: Date | null;
}

export interface ScheduleScopeShape {
  scopeType: ScheduleScopeType;
  organizationId: string;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
}

export type ScheduleConflictSeverity = 'ERROR' | 'WARNING' | 'INFO';

/** The expected-work interval being saved: the merged final state on update. */
export interface ShiftConflictSubject {
  /** Absent on create. */
  id?: string;
  employeeId: string;
  employmentAssignmentId: string;
  startsAt: Date;
  endsAt: Date;
}

/** An existing shift that belongs to the same Employee, on any of their assignments. */
export interface ShiftConflictCandidate {
  id: string;
  scheduleId: string;
  employeeId: string;
  employmentAssignmentId: string;
  workDate: Date;
  startsAt: Date;
  endsAt: Date;
  status: ScheduledShiftStatus;
}

/**
 * A computed conflict. Conflicts are never stored; key identifies this exact conflict
 * state so an accepted override cannot silently cover a different, later conflict.
 */
export interface ScheduleConflict {
  key: string;
  type: ScheduleConflictType;
  severity: ScheduleConflictSeverity;
  overrideAllowed: boolean;
  message: string;
  employeeId: string;
  employmentAssignmentId: string;
  /** The other shift involved; null for a single-shift rule (maximum duration). */
  conflictingShift: ShiftConflictCandidate | null;
  /** The overlapping interval, or for a rest violation the too-short gap between the shifts. */
  overlap: { startsAt: Date; endsAt: Date };
}

interface ConflictKeySide {
  employmentAssignmentId: string;
  startsAt: Date;
  endsAt: Date;
}

const CONFLICT_RULES = {
  SAME_ASSIGNMENT_OVERLAP: {
    severity: 'ERROR',
    overrideAllowed: false,
    message:
      'Shift overlaps another active shift for the same EmploymentAssignment.',
  },
  EMPLOYEE_ASSIGNMENT_OVERLAP: {
    severity: 'WARNING',
    overrideAllowed: true,
    message:
      'Employee already has an active shift on another EmploymentAssignment that overlaps this shift.',
  },
  MINIMUM_REST_VIOLATION: {
    severity: 'WARNING',
    overrideAllowed: true,
    message:
      'The gap between this shift and another active shift of the Employee is shorter than the minimum rest period.',
  },
  MAXIMUM_SHIFT_DURATION_EXCEEDED: {
    severity: 'WARNING',
    overrideAllowed: true,
    message: 'The shift is longer than the maximum shift duration.',
  },
} as const satisfies Record<
  ScheduleConflictType,
  {
    severity: ScheduleConflictSeverity;
    overrideAllowed: boolean;
    message: string;
  }
>;

const SEVERITY_ORDER: Record<ScheduleConflictSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
};

/** Hierarchy columns that each scope type requires; every other narrower column must be null. */
const SCOPE_TARGET_COLUMN = {
  ORGANIZATION: null,
  ORGANIZATIONAL_UNIT: 'organizationalUnitId',
  DEPARTMENT: 'departmentId',
  TEAM: 'teamId',
} as const satisfies Record<
  ScheduleScopeType,
  'organizationalUnitId' | 'departmentId' | 'teamId' | null
>;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** ISO-8601 instant with an explicit UTC designator or offset — never a floating local time. */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const NARROW_SCOPE_COLUMNS = [
  'organizationalUnitId',
  'departmentId',
  'teamId',
] as const;

@Injectable()
export class SchedulingDomainService {
  /**
   * Strict DATE-only input (YYYY-MM-DD) mapped to UTC midnight, the DATE column representation.
   * Rejects timestamps and impossible calendar dates.
   */
  parseDateOnly(value: string, label: string): Date {
    const match = DATE_ONLY_PATTERN.exec(value);
    if (!match) {
      throw new BadRequestException(`${label} must use YYYY-MM-DD format.`);
    }
    const [year, month, day] = match.slice(1).map(Number) as [
      number,
      number,
      number,
    ];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new BadRequestException(`${label} must be a valid calendar date.`);
    }
    return date;
  }

  /**
   * Strict instant input. An explicit Z or ±HH:MM offset is required so neither the
   * client nor the server timezone can change how the value is interpreted.
   */
  parseInstant(value: string, label: string): Date {
    const instant = INSTANT_PATTERN.test(value) ? new Date(value) : null;
    if (!instant || Number.isNaN(instant.getTime())) {
      throw new BadRequestException(
        `${label} must be an ISO-8601 timestamp with an explicit offset.`,
      );
    }
    const localDate = value.slice(0, 10);
    this.parseDateOnly(localDate, label);
    return instant;
  }

  /**
   * Rule 14 — workDate anchors to the shift start.
   * workDate must equal the calendar date of startsAt in the shift's resolved timezone.
   * An overnight shift keeps the workDate of the day it starts.
   */
  assertWorkDateMatchesShiftStart(
    workDate: Date,
    startsAt: Date,
    timezone: string,
  ): void {
    const startDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(startsAt);
    if (startDate !== workDate.toISOString().slice(0, 10)) {
      throw new BadRequestException(
        'Shift workDate must equal the local calendar date of startsAt in the shift timezone.',
      );
    }
  }

  /**
   * Rule 12 — Schedule scope shape.
   * Mirrors the Phase 4/6 scoped-target pattern: organizationId is always required,
   * and exactly the hierarchy column named by scopeType (if any) is set.
   * Enforced in the database by Schedule_scope_target_check.
   */
  assertScheduleScopeShape(scope: ScheduleScopeShape): void {
    if (!Object.hasOwn(SCOPE_TARGET_COLUMN, scope.scopeType)) {
      throw new BadRequestException('Schedule scopeType is not supported.');
    }
    if (!scope.organizationId) {
      throw new BadRequestException('Schedule organizationId is required.');
    }
    const targetColumn = SCOPE_TARGET_COLUMN[scope.scopeType];
    for (const column of NARROW_SCOPE_COLUMNS) {
      const present = Boolean(scope[column]);
      if (column === targetColumn && !present) {
        throw new BadRequestException(
          `Schedule scopeType ${scope.scopeType} requires ${column}.`,
        );
      }
      if (column !== targetColumn && present) {
        throw new BadRequestException(
          `Schedule scopeType ${scope.scopeType} must not set ${column}.`,
        );
      }
    }
  }

  /**
   * Rule 13 — Schedule scope hierarchy.
   * The OrganizationalUnit, Department, or Team selected by scopeType must belong to
   * the Schedule's Organization. Enforced in the database by the composite
   * (id, organizationId) foreign keys.
   */
  assertScopeTargetOrganization(
    scheduleOrganizationId: string,
    scopeTargetOrganizationId: string,
  ): void {
    if (scheduleOrganizationId !== scopeTargetOrganizationId) {
      throw new BadRequestException(
        'Schedule scope target must belong to the same Organization as the Schedule.',
      );
    }
  }

  /**
   * Rule 1 — Schedule period validity.
   * periodStart must be on or before periodEnd.
   */
  assertSchedulePeriod(periodStart: Date, periodEnd: Date): void {
    if (periodStart.getTime() > periodEnd.getTime()) {
      throw new BadRequestException(
        'Schedule periodStart must be on or before periodEnd.',
      );
    }
  }

  /**
   * Rule 2 — Shift interval validity.
   * endsAt must be strictly after startsAt (no zero-duration, no inverted shifts).
   */
  assertShiftInterval(startsAt: Date, endsAt: Date): void {
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException(
        'Shift endsAt must be strictly after startsAt.',
      );
    }
  }

  /**
   * Rule 4 — Schedule membership.
   * workDate must fall within the inclusive Schedule period [periodStart, periodEnd].
   * An overnight shift may end after periodEnd provided its workDate is inside the period.
   */
  assertWorkDateInSchedule(
    workDate: Date,
    periodStart: Date,
    periodEnd: Date,
  ): void {
    if (
      workDate.getTime() < periodStart.getTime() ||
      workDate.getTime() > periodEnd.getTime()
    ) {
      throw new BadRequestException(
        'Shift workDate must fall within the Schedule period (inclusive).',
      );
    }
  }

  /**
   * Rule 7 — EmploymentAssignment lifecycle.
   * Delegates to EmployeeDomainService.isEffectiveOn to reuse Phase 5 lifecycle logic.
   * CANCELLED assignments are always rejected.
   * PLANNED, ACTIVE, and ENDED assignments are accepted when dates are satisfied.
   */
  assertAssignmentEffective(
    assignment: AssignmentEffectivenessCheck,
    workDate: Date,
  ): void {
    if (!EmployeeDomainService.isEffectiveOn(assignment, workDate)) {
      throw new BadRequestException(
        'EmploymentAssignment is not effective on the shift workDate.',
      );
    }
  }

  /**
   * Rule 6 — Organization boundary.
   * The EmploymentAssignment must belong to the same Organization as the Schedule.
   */
  assertOrganizationBoundary(
    scheduleOrganizationId: string,
    assignmentOrganizationId: string,
  ): void {
    if (scheduleOrganizationId !== assignmentOrganizationId) {
      throw new BadRequestException(
        'EmploymentAssignment must belong to the same Organization as the Schedule.',
      );
    }
  }

  /**
   * Rule 8 — WorkLocation organization boundary.
   * If a WorkLocation is provided, it must belong to the same Organization as the Schedule.
   */
  assertWorkLocationOrganization(
    scheduleOrganizationId: string,
    workLocationOrganizationId: string,
  ): void {
    if (scheduleOrganizationId !== workLocationOrganizationId) {
      throw new BadRequestException(
        'WorkLocation must belong to the same Organization as the Schedule.',
      );
    }
  }

  /**
   * Rules 9–11 — Timezone resolution.
   * Prefers WorkLocation.timezone when available.
   * Falls back to an explicit timezone when no WorkLocation timezone is set.
   * IANA validation uses the domain-neutral common timezone utility.
   * Server timezone is never used as a fallback.
   */
  resolveShiftTimezone(
    workLocationTimezone?: string | null,
    explicitTimezone?: string | null,
  ): string {
    const candidate = workLocationTimezone || explicitTimezone;
    if (!candidate) {
      throw new BadRequestException(
        'A valid IANA timezone must be provided for the shift (via WorkLocation or explicitly).',
      );
    }
    return assertIanaTimezone(candidate);
  }

  /**
   * Rule 15 — Expected-work overlap (Phase 7 Batch 3).
   * Intervals are half-open [startsAt, endsAt): touching shifts (one ends exactly when the
   * next starts) do not overlap.
   */
  intervalsOverlap(
    a: { startsAt: Date; endsAt: Date },
    b: { startsAt: Date; endsAt: Date },
  ): boolean {
    return (
      a.startsAt.getTime() < b.endsAt.getTime() &&
      b.startsAt.getTime() < a.endsAt.getTime()
    );
  }

  /**
   * Rules 15–16 — Conflict classification across every Schedule container, plus the Batch 7
   * policy rules. Only ACTIVE shifts of the same Employee participate, and the subject never
   * conflicts with itself.
   * - Same-assignment overlap would create two authoritative expected-work intervals for one
   *   work context: always a non-overrideable ERROR, whatever the policy says.
   * - Overlap across the Employee's other assignments takes the policy's severity (WARNING by
   *   default; ERROR is never overrideable).
   * - A gap shorter than the policy's minimum rest, and a shift longer than its maximum
   *   duration, are overrideable WARNINGs.
   * - When the policy disallows conflict overrides, every WARNING blocks as an ERROR.
   */
  detectShiftConflicts(
    subject: ShiftConflictSubject,
    candidates: readonly ShiftConflictCandidate[],
    policy: ConflictPolicy = DEFAULT_CONFLICT_POLICY,
  ): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = [];
    const add = (
      type: ScheduleConflictType,
      candidate: ShiftConflictCandidate | null,
      window: { startsAt: Date; endsAt: Date },
      threshold?: number,
    ) => {
      const rule = CONFLICT_RULES[type];
      let severity: ScheduleConflictSeverity = rule.severity;
      if (type === 'EMPLOYEE_ASSIGNMENT_OVERLAP') {
        severity = policy.overlapConflictSeverity;
      }
      let overrideAllowed = rule.overrideAllowed && severity === 'WARNING';
      if (severity === 'WARNING' && !policy.allowManagerConflictOverride) {
        severity = 'ERROR';
        overrideAllowed = false;
      }
      conflicts.push({
        key: this.conflictKey(type, subject, candidate, threshold),
        type,
        severity,
        overrideAllowed,
        message: rule.message,
        employeeId: subject.employeeId,
        employmentAssignmentId: subject.employmentAssignmentId,
        conflictingShift: candidate,
        overlap: window,
      });
    };

    const rest = policy.minimumRestMinutes ?? 0;
    for (const candidate of candidates) {
      if (candidate.status !== 'ACTIVE') continue;
      if (subject.id && candidate.id === subject.id) continue;
      if (candidate.employeeId !== subject.employeeId) continue;
      if (this.intervalsOverlap(subject, candidate)) {
        add(
          candidate.employmentAssignmentId === subject.employmentAssignmentId
            ? 'SAME_ASSIGNMENT_OVERLAP'
            : 'EMPLOYEE_ASSIGNMENT_OVERLAP',
          candidate,
          {
            startsAt: new Date(
              Math.max(
                subject.startsAt.getTime(),
                candidate.startsAt.getTime(),
              ),
            ),
            endsAt: new Date(
              Math.min(subject.endsAt.getTime(), candidate.endsAt.getTime()),
            ),
          },
        );
        continue;
      }
      if (rest <= 0) continue;
      const gap =
        candidate.startsAt >= subject.endsAt
          ? { startsAt: subject.endsAt, endsAt: candidate.startsAt }
          : { startsAt: candidate.endsAt, endsAt: subject.startsAt };
      if (gap.endsAt.getTime() - gap.startsAt.getTime() < rest * 60_000) {
        add('MINIMUM_REST_VIOLATION', candidate, gap, rest);
      }
    }
    const maximum = policy.maximumShiftDurationMinutes;
    if (
      maximum !== null &&
      subject.endsAt.getTime() - subject.startsAt.getTime() > maximum * 60_000
    ) {
      add(
        'MAXIMUM_SHIFT_DURATION_EXCEEDED',
        null,
        { startsAt: subject.startsAt, endsAt: subject.endsAt },
        maximum,
      );
    }
    return conflicts.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (a.conflictingShift?.startsAt.getTime() ?? 0) -
          (b.conflictingShift?.startsAt.getTime() ?? 0) ||
        (a.conflictingShift?.id ?? '').localeCompare(
          b.conflictingShift?.id ?? '',
        ),
    );
  }

  /**
   * Stable fingerprint of one conflict state: the type, the subject's assignment and interval,
   * and the conflicting shift's identity, assignment, and interval. Any change to either side
   * produces a different key, so a recorded override only covers the state that was approved.
   */
  conflictKey(
    type: ScheduleConflictType,
    subject: ConflictKeySide,
    conflicting: (ConflictKeySide & { id: string }) | null,
    /** The policy threshold a rest or duration conflict was judged against. */
    threshold?: number,
  ): string {
    const canonical = JSON.stringify([
      'v1',
      type,
      subject.employmentAssignmentId,
      subject.startsAt.toISOString(),
      subject.endsAt.toISOString(),
      ...(conflicting
        ? [
            conflicting.id,
            conflicting.employmentAssignmentId,
            conflicting.startsAt.toISOString(),
            conflicting.endsAt.toISOString(),
          ]
        : []),
      // Overlap keys are unchanged from Batch 3; policy conflicts also fingerprint the
      // threshold, so a policy change makes an earlier approval stale.
      ...(threshold === undefined ? [] : [threshold]),
    ]);
    return createHash('sha256').update(canonical).digest('hex');
  }
}
