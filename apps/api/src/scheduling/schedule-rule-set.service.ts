import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { assertIanaTimezone } from '../common/timezone.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ScheduleDayOfWeek } from '../generated/prisma/enums.js';
import {
  assertRotationWeeks,
  assertWeekIndex,
  findOverlappingRules,
  formatLocalTime,
  minuteToTimeColumn,
  parseLocalTime,
  timeColumnToMinute,
  type RecurrenceInterval,
} from './schedule-recurrence.js';
import type {
  RecurrenceRuleDto,
  UpdateRecurrenceRuleDto,
} from './schedule-recurrence.dto.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';

const RULE_KEYS = [
  'weekIndex',
  'dayOfWeek',
  'startMinute',
  'endMinute',
  'workLocationId',
  'timezone',
  'sortOrder',
] as const;

/** Template and pattern rules share one shape. */
export interface StoredRecurrenceRule {
  id: string;
  weekIndex: number;
  dayOfWeek: ScheduleDayOfWeek;
  startLocalTime: Date;
  endLocalTime: Date;
  workLocationId: string | null;
  timezone: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RuleCandidate extends RecurrenceInterval {
  /** Absent for a rule that does not exist yet. */
  id?: string;
  workLocationId: string | null;
  timezone: string | null;
  sortOrder: number;
  /**
   * New or changed rules get the full reference checks (active WorkLocation, resolvable
   * timezone). Untouched stored rules are only re-checked for rotation fit and overlap, so a
   * WorkLocation archived later does not block unrelated edits.
   */
  fresh: boolean;
}

export type RuleData = Pick<
  StoredRecurrenceRule,
  | 'weekIndex'
  | 'dayOfWeek'
  | 'startLocalTime'
  | 'endLocalTime'
  | 'workLocationId'
  | 'timezone'
  | 'sortOrder'
>;

/**
 * Validation and representation of a recurrence rule set (a template's or a pattern's).
 * Rules are local wall-clock intervals: no instants and no DST resolution here; Batch 6
 * resolves each occurrence with the Scheduling timezone rule (WorkLocation timezone first,
 * then the rule's explicit fallback, never a browser or server timezone).
 */
@Injectable()
export class ScheduleRuleSetService {
  constructor(private readonly domain: SchedulingDomainService) {}

  fromInput(input: RecurrenceRuleDto): RuleCandidate {
    return {
      weekIndex: input.weekIndex,
      dayOfWeek: input.dayOfWeek,
      startMinute: parseLocalTime(input.startLocalTime, 'startLocalTime'),
      endMinute: parseLocalTime(input.endLocalTime, 'endLocalTime'),
      workLocationId: input.workLocationId ?? null,
      timezone: input.timezone?.trim() || null,
      sortOrder: input.sortOrder ?? 0,
      fresh: true,
    };
  }

  fromStored(rule: StoredRecurrenceRule): RuleCandidate {
    return {
      id: rule.id,
      weekIndex: rule.weekIndex,
      dayOfWeek: rule.dayOfWeek,
      startMinute: timeColumnToMinute(rule.startLocalTime),
      endMinute: timeColumnToMinute(rule.endLocalTime),
      workLocationId: rule.workLocationId,
      timezone: rule.timezone,
      sortOrder: rule.sortOrder,
      fresh: false,
    };
  }

  /** The merged final state of a rule update; fresh only if something actually changed. */
  merge(
    rule: StoredRecurrenceRule,
    input: UpdateRecurrenceRuleDto,
  ): RuleCandidate {
    const stored = this.fromStored(rule);
    const merged: RuleCandidate = {
      ...stored,
      weekIndex: input.weekIndex ?? stored.weekIndex,
      dayOfWeek: input.dayOfWeek ?? stored.dayOfWeek,
      startMinute:
        input.startLocalTime === undefined
          ? stored.startMinute
          : parseLocalTime(input.startLocalTime, 'startLocalTime'),
      endMinute:
        input.endLocalTime === undefined
          ? stored.endMinute
          : parseLocalTime(input.endLocalTime, 'endLocalTime'),
      workLocationId:
        input.workLocationId === undefined
          ? stored.workLocationId
          : input.workLocationId,
      timezone:
        input.timezone === undefined
          ? stored.timezone
          : input.timezone?.trim() || null,
      sortOrder: input.sortOrder ?? stored.sortOrder,
      fresh: false,
    };
    merged.fresh = RULE_KEYS.some((key) => merged[key] !== stored[key]);
    return merged;
  }

  /**
   * Validates a complete rule set for one rotation and returns rows ready to persist, in input
   * order. Multiple intervals per day are fine; overlapping ones (including an overnight rule
   * running into the next day, and the rotation wrapping from its last week to week 0) are not.
   */
  async validate(
    organizationId: string,
    rotationWeeks: number,
    rules: readonly RuleCandidate[],
    client: Prisma.TransactionClient,
  ): Promise<RuleData[]> {
    assertRotationWeeks(rotationWeeks);
    const locations = new Map<
      string,
      {
        organizationId: string;
        archivedAt: Date | null;
        timezone: string | null;
      }
    >();
    for (const rule of rules) {
      assertWeekIndex(rule.weekIndex, rotationWeeks);
      if (!rule.fresh) continue;
      let workLocationTimezone: string | null = null;
      if (rule.workLocationId) {
        let location = locations.get(rule.workLocationId);
        if (!location) {
          const row = await client.workLocation.findUnique({
            where: { id: rule.workLocationId },
            select: { organizationId: true, archivedAt: true, timezone: true },
          });
          if (!row) throw new NotFoundException('WorkLocation not found');
          location = row;
          locations.set(rule.workLocationId, row);
        }
        if (location.organizationId !== organizationId) {
          throw new BadRequestException(
            'WorkLocation must belong to the same Organization.',
          );
        }
        if (location.archivedAt) {
          throw new BadRequestException(
            'Recurring rules cannot use an archived WorkLocation.',
          );
        }
        workLocationTimezone = location.timezone;
      }
      if (rule.timezone) assertIanaTimezone(rule.timezone);
      // Every occurrence must resolve to exactly one IANA timezone without any runtime fallback.
      this.domain.resolveShiftTimezone(workLocationTimezone, rule.timezone);
    }

    const overlap = findOverlappingRules(rules, rotationWeeks);
    if (overlap) {
      throw new BadRequestException(
        `Recurring rules overlap: ${overlap.map((rule) => this.describe(rule)).join(' and ')}.`,
      );
    }
    return rules.map((rule) => this.toData(rule));
  }

  toData(rule: RuleCandidate): RuleData {
    return {
      weekIndex: rule.weekIndex,
      dayOfWeek: rule.dayOfWeek,
      startLocalTime: minuteToTimeColumn(rule.startMinute),
      endLocalTime: minuteToTimeColumn(rule.endMinute),
      workLocationId: rule.workLocationId,
      timezone: rule.timezone,
      sortOrder: rule.sortOrder,
    };
  }

  /** Copies stored rules as new rows, e.g. a template's rules into a pattern. */
  copy(rule: StoredRecurrenceRule): RuleCandidate {
    return { ...this.fromStored(rule), id: undefined, fresh: true };
  }

  shape(rule: StoredRecurrenceRule) {
    const startMinute = timeColumnToMinute(rule.startLocalTime);
    const endMinute = timeColumnToMinute(rule.endLocalTime);
    return {
      id: rule.id,
      weekIndex: rule.weekIndex,
      dayOfWeek: rule.dayOfWeek,
      startLocalTime: formatLocalTime(startMinute),
      endLocalTime: formatLocalTime(endMinute),
      /** True when the interval ends on the following local day. */
      overnight: endMinute <= startMinute,
      workLocationId: rule.workLocationId,
      timezone: rule.timezone,
      sortOrder: rule.sortOrder,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  /** A stable, human-readable ordering for rule lists. */
  readonly ruleOrder = [
    { weekIndex: 'asc' },
    { dayOfWeek: 'asc' },
    { startLocalTime: 'asc' },
    { sortOrder: 'asc' },
    { id: 'asc' },
  ] as const;

  private describe(rule: RuleCandidate) {
    return `week ${rule.weekIndex} ${rule.dayOfWeek} ${formatLocalTime(rule.startMinute)}–${formatLocalTime(rule.endMinute)}`;
  }
}
