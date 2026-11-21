import type { LeavePolicy } from '../generated/prisma/client.js';
import {
  addDays,
  daysBetweenInclusive,
  formatDate,
  maxDate,
  minDate,
} from './leave-common.js';
import { leaveYearEndOf, leaveYearStartOf } from './leave-policy.js';

/**
 * Phase 8 — the pure entitlement plan for one leave account. Given the policy in effect on each
 * date, the assignment's eligibility window and the account's existing ledger, it yields the
 * GRANT / ACCRUAL / CARRYOVER_FORFEIT / EXPIRY postings (and system reversals) due by `asOf`.
 *
 * Every decision has a deterministic key ("family"). The first posting uses the key itself.
 * When a later supported ledger change moves the decision (for example leave recorded or
 * cancelled after the fact in a closed leave year), the family is settled to the new amount:
 *  - owed more in its own direction → the difference is posted as `key#n`;
 *  - owed less → every earlier posting of the family is reversed (a REVERSAL referencing it)
 *    and the new amount is posted as `key#n`. History is never rewritten.
 * A family an administrator reversed by hand is theirs: it is no longer settled automatically.
 * A zero decision posts nothing and is re-evaluated on the next run. Rerunning with an
 * unchanged ledger therefore posts nothing.
 *
 * Balance cap (maxBalanceMinutes): a grant or accrual never takes the account above the cap.
 * The basis is the account's current balance on the posting's effective date: every entry
 * effective on or before that date (entitlement, taken leave, adjustments, year-end postings),
 * never approved leave dated later, so booked future leave cannot make room for more
 * entitlement. Only the allowed part posts; nothing posts at or above the cap.
 */
export interface PlanEntry {
  id?: string;
  amountMinutes: number;
  effectiveDate: Date;
  /** Leave usage and its reversals reference a request day. */
  leaveRequestDayId: string | null;
  idempotencyKey?: string;
  entryType?: string;
  reversesEntryId?: string | null;
  sourceType?: string;
}

export interface PlannedPosting {
  entryType: 'GRANT' | 'ACCRUAL' | 'CARRYOVER_FORFEIT' | 'EXPIRY';
  amountMinutes: number;
  effectiveDate: Date;
  idempotencyKey: string;
  policyId: string;
  sourceType: 'POLICY' | 'YEAR_END';
}

/** A system reversal of an earlier posting whose family is being settled downwards. */
export interface PlannedReversal {
  entryType: 'REVERSAL';
  reversesEntryId: string;
  amountMinutes: number;
  effectiveDate: Date;
  sourceType: 'POLICY' | 'YEAR_END';
  reason: string;
}

export interface EntitlementPlanInput {
  accountId: string;
  asOf: Date;
  /** First date grants and accruals are planned for. */
  scanFrom: Date;
  /**
   * First date year ends (carryover forfeiture and expiry) are evaluated from; defaults to
   * scanFrom. Reaches further back so a carryover expiry longer than the lookback is still met.
   */
  yearEndScanFrom?: Date;
  /** Eligibility window of the assignment (before the policy waiting period). */
  assignmentStart: Date;
  assignmentEnd: Date | null;
  policyAt: (date: Date) => LeavePolicy | null;
  entries: readonly PlanEntry[];
  existingKeys: ReadonlySet<string>;
}

const familyOf = (key: string) => key.split('#')[0]!;

/** The accrual period containing `date`. */
function periodOf(date: Date, policy: LeavePolicy): { start: Date; end: Date } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const monthEnd = new Date(Date.UTC(year, month + 1, 0));
  switch (policy.accrualFrequency) {
    case 'SEMI_MONTHLY':
      return date.getUTCDate() <= 15
        ? {
            start: new Date(Date.UTC(year, month, 1)),
            end: new Date(Date.UTC(year, month, 15)),
          }
        : { start: new Date(Date.UTC(year, month, 16)), end: monthEnd };
    case 'BIWEEKLY': {
      const anchor = policy.accrualAnchorDate!;
      const offset = Math.floor(
        (date.getTime() - anchor.getTime()) / 86_400_000,
      );
      const start = addDays(anchor, Math.floor(offset / 14) * 14);
      return { start, end: addDays(start, 13) };
    }
    default:
      return { start: new Date(Date.UTC(year, month, 1)), end: monthEnd };
  }
}

export function planEntitlements(
  input: EntitlementPlanInput,
): Array<PlannedPosting | PlannedReversal> {
  const planned: Array<PlannedPosting | PlannedReversal> = [];
  const entries: PlanEntry[] = [...input.entries];
  const keys = new Set(input.existingKeys);
  const inFamily = (entry: PlanEntry, base: string) =>
    entry.idempotencyKey !== undefined &&
    familyOf(entry.idempotencyKey) === base;
  /** Balance on `date`, leaving out one family's own postings (and their reversals). */
  const balanceAt = (date: Date, excludeFamily?: string) => {
    const excluded = new Set(
      excludeFamily
        ? entries
            .filter((e) => inFamily(e, excludeFamily) && e.id)
            .map((e) => e.id!)
        : [],
    );
    return entries.reduce(
      (sum, e) =>
        e.effectiveDate <= date &&
        !(excludeFamily && inFamily(e, excludeFamily)) &&
        !(e.reversesEntryId && excluded.has(e.reversesEntryId))
          ? sum + e.amountMinutes
          : sum,
      0,
    );
  };

  /** Settles the family `base` (whose postings have direction `sign`) to `desired` minutes. */
  const settle = (
    base: string,
    desired: number,
    sign: 1 | -1,
    posting: Omit<PlannedPosting, 'amountMinutes' | 'idempotencyKey'>,
  ) => {
    const family = entries.filter((e) => inFamily(e, base));
    // Known only by key (no amounts supplied): already decided.
    if (family.length === 0 && keys.has(base)) return;
    const reversalOf = (member: PlanEntry) =>
      member.id
        ? entries.find((e) => e.reversesEntryId === member.id)
        : undefined;
    // Reversed by hand: an administrator's decision the plan does not override.
    if (family.some((member) => reversalOf(member)?.sourceType === 'MANUAL'))
      return;
    const effective = family.reduce(
      (sum, member) =>
        sum + member.amountMinutes + (reversalOf(member)?.amountMinutes ?? 0),
      0,
    );
    if (desired === effective) return;
    const key = `${base}#${family.length}`;
    const post = (amount: number, idempotencyKey: string) => {
      if (keys.has(idempotencyKey)) return;
      keys.add(idempotencyKey);
      planned.push({ ...posting, amountMinutes: amount, idempotencyKey });
      entries.push({
        amountMinutes: amount,
        effectiveDate: posting.effectiveDate,
        leaveRequestDayId: null,
        idempotencyKey,
        entryType: posting.entryType,
      });
    };
    const delta = desired - effective;
    if (Math.sign(delta) === sign) {
      post(delta, family.length === 0 ? base : key);
      return;
    }
    // Owed less: reverse what stands, then post the new amount.
    for (const member of family) {
      if (!member.id || reversalOf(member)) continue;
      planned.push({
        entryType: 'REVERSAL',
        reversesEntryId: member.id,
        amountMinutes: -member.amountMinutes,
        effectiveDate: member.effectiveDate,
        sourceType: posting.sourceType,
        reason: `Recalculated ${posting.entryType.toLowerCase().replace('_', ' ')} after a later ledger change`,
      });
      entries.push({
        amountMinutes: -member.amountMinutes,
        effectiveDate: member.effectiveDate,
        leaveRequestDayId: null,
        reversesEntryId: member.id,
        sourceType: posting.sourceType,
        entryType: 'REVERSAL',
      });
    }
    if (desired !== 0) post(desired, key);
  };
  const capped = (
    policy: LeavePolicy,
    amount: number,
    date: Date,
    base: string,
  ) =>
    policy.maxBalanceMinutes === null
      ? amount
      : Math.min(
          amount,
          Math.max(0, policy.maxBalanceMinutes - balanceAt(date, base)),
        );
  /** Entitlement periods already granted (family base → period), for the one-grant rule. */
  const grantedPeriods = () =>
    [
      ...new Set(
        entries
          .filter((e) => e.idempotencyKey?.startsWith('grant:'))
          .map((e) => familyOf(e.idempotencyKey!)),
      ),
    ].map((base) => {
      const [, , start, end] = base.split(':');
      const from = new Date(`${start}T00:00:00.000Z`);
      return {
        base,
        start: from,
        end: end ? new Date(`${end}T00:00:00.000Z`) : leaveYearEndOf(from),
      };
    });

  const active = (date: Date) =>
    date >= input.assignmentStart &&
    (input.assignmentEnd === null || date <= input.assignmentEnd);
  const start =
    input.yearEndScanFrom && input.yearEndScanFrom < input.scanFrom
      ? input.yearEndScanFrom
      : input.scanFrom;

  for (let day = start; day <= input.asOf; day = addDays(day, 1)) {
    const policy = input.policyAt(day);

    // Year end: `day` starts a new leave year of the policy in effect on the previous day.
    const previous = addDays(day, -1);
    const yearEndPolicy = input.policyAt(previous);
    if (
      yearEndPolicy?.eligible &&
      leaveYearStartOf(day, yearEndPolicy).getTime() === day.getTime() &&
      active(previous)
    ) {
      const forfeitKey = `yearend:${input.accountId}:${formatDate(day)}`;
      const balance = balanceAt(previous);
      let forfeit = 0;
      if (yearEndPolicy.carryoverMode === 'NONE')
        forfeit = Math.max(0, balance);
      if (yearEndPolicy.carryoverMode === 'CAPPED') {
        forfeit = Math.max(
          0,
          balance - (yearEndPolicy.carryoverMaxMinutes ?? 0),
        );
      }
      settle(forfeitKey, -forfeit, -1, {
        entryType: 'CARRYOVER_FORFEIT',
        effectiveDate: day,
        policyId: yearEndPolicy.id,
        sourceType: 'YEAR_END',
      });
      if (
        yearEndPolicy.carryoverMode !== 'NONE' &&
        yearEndPolicy.carryoverExpiryDays
      ) {
        const expiresOn = addDays(day, yearEndPolicy.carryoverExpiryDays);
        if (expiresOn <= input.asOf) {
          const expiryKey = `carryexpiry:${input.accountId}:${formatDate(day)}`;
          const carried = Math.max(0, balance - forfeit);
          // Carried minutes are consumed first by leave taken before they expire.
          const used = Math.max(
            0,
            -entries
              .filter(
                (e) =>
                  e.leaveRequestDayId &&
                  e.effectiveDate >= day &&
                  e.effectiveDate < expiresOn,
              )
              .reduce((sum, e) => sum + e.amountMinutes, 0),
          );
          const remaining = Math.max(0, carried - used);
          const expire = Math.min(
            remaining,
            Math.max(0, balanceAt(addDays(expiresOn, -1), expiryKey)),
          );
          settle(expiryKey, -expire, -1, {
            entryType: 'EXPIRY',
            effectiveDate: expiresOn,
            policyId: yearEndPolicy.id,
            sourceType: 'YEAR_END',
          });
        }
      }
    }

    if (day < input.scanFrom || !policy?.eligible || !active(day)) continue;
    const eligibleFrom = addDays(
      input.assignmentStart,
      policy.waitingPeriodDays,
    );

    if (policy.accrualMethod === 'ANNUAL_GRANT' && policy.annualGrantMinutes) {
      const yearStart = leaveYearStartOf(day, policy);
      const yearEnd = leaveYearEndOf(yearStart);
      const grantDate = maxDate(
        maxDate(yearStart, eligibleFrom),
        policy.effectiveFrom,
      );
      if (day.getTime() === grantDate.getTime() && grantDate <= yearEnd) {
        const amount =
          policy.prorateFirstYear && grantDate > yearStart
            ? Math.round(
                (policy.annualGrantMinutes *
                  daysBetweenInclusive(grantDate, yearEnd)) /
                  daysBetweenInclusive(yearStart, yearEnd),
              )
            : policy.annualGrantMinutes;
        // One grant per entitlement period: the key is the period itself, and a period that
        // shares most of its days with an already granted one (the leave-year start moved in a
        // later policy version) is the same entitlement year, so it is not granted again.
        const base = `grant:${input.accountId}:${formatDate(yearStart)}:${formatDate(yearEnd)}`;
        const sameYear = grantedPeriods().some(
          (granted) =>
            granted.base !== base &&
            2 *
              Math.max(
                0,
                daysBetweenInclusive(
                  maxDate(granted.start, yearStart),
                  minDate(granted.end, yearEnd),
                ),
              ) >
              daysBetweenInclusive(yearStart, yearEnd),
        );
        // A grant is decided on its own grant date by the policy then in force; a later policy
        // version of the same period never re-decides (tops up or claws back) an earned grant.
        const decidedEarlier = entries.some(
          (e) =>
            inFamily(e, base) &&
            e.effectiveDate.getTime() !== grantDate.getTime(),
        );
        if (!sameYear && !decidedEarlier) {
          settle(base, capped(policy, amount, grantDate, base), 1, {
            entryType: 'GRANT',
            effectiveDate: grantDate,
            policyId: policy.id,
            sourceType: 'POLICY',
          });
        }
      }
    }

    /*
     * Periodic accrual is posted per (policy, period) segment, on the segment's last day once it
     * has passed: the period end, the last day this policy applies (a successor policy or the
     * policy's end), or the assignment's last day. A segment cut short by a policy boundary is
     * always prorated, so a mid-period policy change neither loses nor double-pays the month;
     * one cut short by eligibility starting or the assignment ending is prorated only when the
     * policy prorates partial periods (prorateFirstYear).
     */
    if (
      policy.accrualMethod === 'PERIODIC' &&
      policy.accrualMinutesPerPeriod &&
      day < input.asOf
    ) {
      const period = periodOf(day, policy);
      const policyEnds = input.policyAt(addDays(day, 1))?.id !== policy.id;
      const assignmentEnds =
        input.assignmentEnd !== null &&
        day.getTime() === input.assignmentEnd.getTime();
      if (
        day.getTime() === period.end.getTime() ||
        policyEnds ||
        assignmentEnds
      ) {
        let segmentStart = day;
        while (
          segmentStart > period.start &&
          input.policyAt(addDays(segmentStart, -1))?.id === policy.id
        ) {
          segmentStart = addDays(segmentStart, -1);
        }
        const coveredFrom = maxDate(segmentStart, eligibleFrom);
        if (coveredFrom <= day) {
          const full =
            coveredFrom.getTime() === period.start.getTime() &&
            day.getTime() === period.end.getTime();
          const boundary =
            segmentStart > period.start || (policyEnds && day < period.end);
          if (full || boundary || policy.prorateFirstYear) {
            const amount = full
              ? policy.accrualMinutesPerPeriod
              : Math.round(
                  (policy.accrualMinutesPerPeriod *
                    daysBetweenInclusive(coveredFrom, day)) /
                    daysBetweenInclusive(period.start, period.end),
                );
            const key = `accrual:${input.accountId}:${policy.id}:${formatDate(coveredFrom)}`;
            settle(key, capped(policy, amount, day, key), 1, {
              entryType: 'ACCRUAL',
              effectiveDate: day,
              policyId: policy.id,
              sourceType: 'POLICY',
            });
          }
        }
      }
    }
  }
  return planned;
}

/** The furthest back a year end can still owe an expiry for these policies. */
export function longestCarryoverExpiryDays(policies: readonly LeavePolicy[]) {
  return policies.reduce(
    (max, p) => Math.max(max, p.carryoverExpiryDays ?? 0),
    0,
  );
}
