import { Injectable } from '@nestjs/common';
import { FeatureGateService } from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { LeavePolicy } from '../generated/prisma/client.js';
import {
  addDays,
  currentDates,
  formatDate,
  localDateOf,
  maxDate,
  minDate,
  positionTargets,
  resolveLeaveTimezone,
} from './leave-common.js';
import {
  longestCarryoverExpiryDays,
  planEntitlements,
} from './leave-entitlement.js';
import { LeaveLedgerService } from './leave-ledger.service.js';
import { resolveLeavePolicy } from './leave-policy.js';

/** How far back a run looks for due entitlements (covers a missed year end plus slack). */
export const DEFAULT_ENTITLEMENT_LOOKBACK_DAYS = 400;
export const MAX_ENTITLEMENT_LOOKBACK_DAYS = 800;

export interface EntitlementRunOptions {
  /** Local date the run is "as of" for every assignment; defaults to each assignment's today. */
  asOf?: Date;
  organizationId?: string;
  lookbackDays?: number;
}

export interface EntitlementRunOutcome {
  asOf: string | null;
  accounts: number;
  posted: Record<
    'GRANT' | 'ACCRUAL' | 'CARRYOVER_FORFEIT' | 'EXPIRY' | 'REVERSAL',
    number
  >;
  failed: Array<{
    employmentAssignmentId: string;
    leaveTypeId: string;
    message: string;
  }>;
  /** Phase 18: organizations skipped because Leave is disabled for them. */
  skippedOrganizations: string[];
}

/**
 * Phase 8 — leave entitlement processing: annual grants (optionally prorated), periodic
 * accrual (monthly, semi-monthly, bi-weekly; capped by maxBalanceMinutes), year-end carryover
 * forfeiture and carryover expiry. Trusted internal work like Phase 7 generation: each account
 * is its own transaction under its row lock, every posting has a deterministic idempotency key,
 * and failures are reported, not thrown, so one bad account never blocks the rest and a retry
 * only posts what is still missing. Hours-worked accrual is intentionally not implemented.
 */
@Injectable()
export class LeaveEntitlementService {
  /** The clock; tests replace it. Entitlements are never posted ahead of an assignment's today. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LeaveLedgerService,
  ) {}

  async processEntitlements(
    options: EntitlementRunOptions = {},
  ): Promise<EntitlementRunOutcome> {
    const lookback = options.lookbackDays ?? DEFAULT_ENTITLEMENT_LOOKBACK_DAYS;
    if (
      options.asOf &&
      options.asOf > currentDates(this.now().getTime()).latest
    ) {
      throw new Error(
        'asOf cannot be in the future: future entitlements are never posted ahead of time.',
      );
    }
    const outcome: EntitlementRunOutcome = {
      asOf: options.asOf ? formatDate(options.asOf) : null,
      accounts: 0,
      posted: {
        GRANT: 0,
        ACCRUAL: 0,
        CARRYOVER_FORFEIT: 0,
        EXPIRY: 0,
        REVERSAL: 0,
      },
      failed: [],
      skippedOrganizations: [],
    };
    const disabled = await new FeatureGateService(
      this.prisma,
    ).disabledOrganizations('LEAVE');
    outcome.skippedOrganizations = [...disabled]
      .filter((id) => !options.organizationId || id === options.organizationId)
      .sort();
    const types = await this.prisma.leaveType.findMany({
      where: {
        archivedAt: null,
        tracksBalance: true,
        AND: [{ organizationId: { notIn: [...disabled] } }],
        ...(options.organizationId
          ? { organizationId: options.organizationId }
          : {}),
        policies: {
          some: {
            OR: [
              { accrualMethod: { not: 'NONE' } },
              { carryoverMode: { not: 'UNLIMITED' } },
              { carryoverExpiryDays: { not: null } },
            ],
          },
        },
      },
      include: { policies: true },
    });
    if (types.length === 0) return outcome;
    const organizationIds = [...new Set(types.map((t) => t.organizationId))];
    const earliestAsOf =
      options.asOf ?? currentDates(this.now().getTime()).earliest;
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: {
        status: { in: ['ACTIVE', 'ENDED'] },
        position: { organizationId: { in: organizationIds } },
        OR: [
          { endDate: null },
          { endDate: { gte: addDays(earliestAsOf, -lookback) } },
        ],
      },
      include: {
        employee: { select: { terminationDate: true } },
        position: {
          select: {
            id: true,
            organizationId: true,
            organizationalUnitId: true,
            departmentId: true,
            teamId: true,
            workLocation: { select: { timezone: true } },
            organization: { select: { timezone: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const targets = await positionTargets(
      this.prisma,
      assignments.map((a) => a.position),
    );

    for (const assignment of assignments) {
      for (const type of types.filter(
        (t) => t.organizationId === assignment.position.organizationId,
      )) {
        try {
          const posted = await this.processAccount(
            assignment,
            type.id,
            type.policies,
            targets.get(assignment.position.id)!,
            options,
            lookback,
          );
          if (posted === null) continue;
          outcome.accounts += 1;
          for (const [kind, count] of Object.entries(posted)) {
            outcome.posted[kind as keyof EntitlementRunOutcome['posted']] +=
              count;
          }
        } catch (error) {
          outcome.failed.push({
            employmentAssignmentId: assignment.id,
            leaveTypeId: type.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return outcome;
  }

  private async processAccount(
    assignment: {
      id: string;
      employeeId: string;
      employmentType: LeavePolicy['employmentTypes'][number];
      startDate: Date;
      endDate: Date | null;
      employee: { terminationDate: Date | null };
      position: Parameters<typeof resolveLeaveTimezone>[0];
    },
    leaveTypeId: string,
    policies: LeavePolicy[],
    target: Parameters<typeof resolveLeavePolicy>[1]['target'],
    options: EntitlementRunOptions,
    lookback: number,
  ): Promise<Record<string, number> | null> {
    const subject = {
      employmentAssignmentId: assignment.id,
      employmentType: assignment.employmentType,
      target,
    };
    const policyAt = (date: Date) =>
      resolveLeavePolicy(policies, subject, date);
    const timezone = resolveLeaveTimezone(assignment.position);
    // An explicit asOf may lag, never lead, the assignment's local today.
    const today = localDateOf(this.now(), timezone);
    const asOf = options.asOf ? minDate(options.asOf, today) : today;
    const scanFrom = maxDate(addDays(asOf, -lookback), assignment.startDate);
    const yearEndScanFrom = maxDate(
      addDays(asOf, -(lookback + longestCarryoverExpiryDays(policies))),
      assignment.startDate,
    );
    if (scanFrom > asOf) return null;
    // Skip assignments no accruing or carryover-limited policy covers in the window, so no
    // empty account is created for them.
    let relevant = false;
    for (
      let day = yearEndScanFrom;
      day <= asOf && !relevant;
      day = addDays(day, 1)
    ) {
      const policy = policyAt(day);
      relevant =
        !!policy?.eligible &&
        (policy.accrualMethod !== 'NONE' ||
          policy.carryoverMode !== 'UNLIMITED' ||
          policy.carryoverExpiryDays !== null);
    }
    if (!relevant) return null;
    const end =
      [assignment.endDate, assignment.employee.terminationDate]
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    return this.prisma.$transaction(async (tx) => {
      // The shared lock order: assignment, then account.
      await this.ledger.lockAssignment(tx, assignment.id);
      const account = await this.ledger.ensureAccount(tx, {
        employeeId: assignment.employeeId,
        employmentAssignmentId: assignment.id,
        leaveTypeId,
      });
      await this.ledger.lockAccount(tx, account.id);
      const existing = await tx.leaveLedgerEntry.findMany({
        where: { accountId: account.id },
      });
      const plan = planEntitlements({
        accountId: account.id,
        asOf,
        scanFrom,
        yearEndScanFrom,
        assignmentStart: assignment.startDate,
        assignmentEnd: end,
        policyAt,
        entries: existing,
        existingKeys: new Set(existing.map((e) => e.idempotencyKey)),
      });
      const counts: Record<string, number> = {
        GRANT: 0,
        ACCRUAL: 0,
        CARRYOVER_FORFEIT: 0,
        EXPIRY: 0,
        REVERSAL: 0,
      };
      for (const posting of plan) {
        if (posting.entryType === 'REVERSAL') {
          const original = existing.find(
            (e) => e.id === posting.reversesEntryId,
          )!;
          const { created } = await this.ledger.postReversal(tx, original, {
            reason: posting.reason,
            sourceType: posting.sourceType,
            createdByUserId: null,
          });
          if (created) counts.REVERSAL += 1;
          continue;
        }
        const { created } = await this.ledger.post(tx, { account, ...posting });
        if (created) counts[posting.entryType] += 1;
      }
      return counts;
    });
  }
}
