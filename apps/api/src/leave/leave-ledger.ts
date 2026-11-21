import type { LeavePolicy } from '../generated/prisma/client.js';
import { addDays, formatDate } from './leave-common.js';
import { leaveYearEndOf, leaveYearStartOf } from './leave-policy.js';

/**
 * Phase 8 — balance semantics over the append-only ledger. No balance is ever stored.
 *
 *   current   = net entries effective on or before asOf
 *   scheduled = approved leave usage dated after asOf (net of its reversals), as a positive
 *               number of minutes: committed future leave
 *   available = every posted entry (entitlement minus all approved usage, past and future);
 *               future accruals are never posted ahead of time, so they are never counted
 *
 * Approving future leave therefore reduces `available` immediately while it stays visible as
 * `scheduled`; when its date passes it simply moves into `current`. Usage reversals carry the
 * original's effective date and request day, so cancelling leave restores exactly what it took.
 *
 * These are the account-level figures shown on balances. Whether a request fits is decided per
 * leave year instead (leaveYearBalanceCheck below): this year's balance never pays for next
 * year's leave that the year end would forfeit, and future entitlement is never assumed.
 */
export interface BalanceEntry {
  amountMinutes: number;
  effectiveDate: Date;
  /** Usage and usage reversals reference the request day they belong to. */
  leaveRequestDayId: string | null;
}

export interface LeaveBalance {
  currentMinutes: number;
  scheduledMinutes: number;
  availableMinutes: number;
}

export function summarizeBalance(
  entries: readonly BalanceEntry[],
  asOf: Date,
): LeaveBalance {
  let current = 0;
  let scheduled = 0;
  let available = 0;
  for (const entry of entries) {
    available += entry.amountMinutes;
    if (entry.effectiveDate <= asOf) {
      current += entry.amountMinutes;
    } else if (entry.leaveRequestDayId) {
      scheduled -= entry.amountMinutes;
    }
  }
  return {
    currentMinutes: current,
    scheduledMinutes: scheduled,
    availableMinutes: available,
  };
}

/** Entry types an adjuster may reverse directly; usage is reversed only by amending leave. */
export const MANUALLY_REVERSIBLE_TYPES = [
  'GRANT',
  'ACCRUAL',
  'ADJUSTMENT',
  'CARRYOVER_FORFEIT',
  'EXPIRY',
] as const;

// ─── Leave-year projection (request balance checks) ──────────────────────────

export interface ProjectionEntry {
  amountMinutes: number;
  effectiveDate: Date;
  leaveRequestDayId: string | null;
  idempotencyKey?: string;
  entryType?: string;
  sourceType?: string;
}

export interface LeaveYearBalance {
  start: Date;
  end: Date;
  /** Projected balance at the end of the leave year. */
  endBalanceMinutes: number;
  negativeBalanceLimitMinutes: number;
}

/** Calendar-year schedule for dates no policy covers. */
const CALENDAR_YEAR = { leaveYearStartMonth: 1, leaveYearStartDay: 1 };

/**
 * Projects the end-of-leave-year balance of every leave year from the one containing `today`
 * through `through`, from posted entries only (no hypothetical grants or accruals):
 *  - the current leave year holds every posted entry dated up to its end (history included);
 *  - each year end applies the carryover rule of the policy in force on the year's last day
 *    (NONE forfeits the positive balance, CAPPED the excess) unless that forfeiture is already
 *    posted, and carryover expiry subtracts the carried minutes not used before they expire
 *    (unless already posted);
 *  - a later year starts from what carries in and adds the entries dated inside it.
 * So leave in a future year is covered by what will carry into that year plus entitlement
 * already granted for it, never by this year's balance that the year end will forfeit.
 */
export function projectLeaveYears(input: {
  accountId: string;
  entries: readonly ProjectionEntry[];
  today: Date;
  through: Date;
  policyAt: (date: Date) => LeavePolicy | null;
}): LeaveYearBalance[] {
  const scheduleAt = (date: Date) => input.policyAt(date) ?? CALENDAR_YEAR;
  const yearOf = (date: Date) => {
    const start = leaveYearStartOf(date, scheduleAt(date));
    return { start, end: leaveYearEndOf(start) };
  };
  const sum = (filter: (e: ProjectionEntry) => boolean) =>
    input.entries.reduce(
      (total, e) => (filter(e) ? total + e.amountMinutes : total),
      0,
    );

  const years: LeaveYearBalance[] = [];
  let year = yearOf(input.today);
  let running = sum((e) => e.effectiveDate < year.start);
  const pendingExpiries: { date: Date; minutes: number }[] = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const yearEndPolicy = input.policyAt(addDays(year.start, -1));
    let carried = running;
    if (yearEndPolicy?.eligible) {
      let forfeit = 0;
      if (yearEndPolicy.carryoverMode === 'NONE')
        forfeit = Math.max(0, running);
      if (yearEndPolicy.carryoverMode === 'CAPPED') {
        forfeit = Math.max(
          0,
          running - (yearEndPolicy.carryoverMaxMinutes ?? 0),
        );
      }
      // Already posted (net of system reversals) at this year's start.
      const posted = -sum(
        (e) =>
          e.effectiveDate.getTime() === year.start.getTime() &&
          (e.entryType === 'CARRYOVER_FORFEIT' ||
            (e.entryType === 'REVERSAL' && e.sourceType === 'YEAR_END')),
      );
      running -= Math.max(0, forfeit - posted);
      carried = Math.max(0, carried - forfeit);
      const expiryKey = `carryexpiry:${input.accountId}:${formatDate(year.start)}`;
      if (
        yearEndPolicy.carryoverMode !== 'NONE' &&
        yearEndPolicy.carryoverExpiryDays &&
        !input.entries.some(
          (e) => e.idempotencyKey?.split('#')[0] === expiryKey,
        )
      ) {
        const expiresOn = addDays(
          year.start,
          yearEndPolicy.carryoverExpiryDays,
        );
        // Carried minutes are consumed first by leave taken before they expire.
        const used = -sum(
          (e) =>
            !!e.leaveRequestDayId &&
            e.effectiveDate >= year.start &&
            e.effectiveDate < expiresOn,
        );
        const expire = Math.max(0, carried - Math.max(0, used));
        if (expire > 0)
          pendingExpiries.push({ date: expiresOn, minutes: expire });
      }
    }
    running += sum(
      (e) => e.effectiveDate >= year.start && e.effectiveDate <= year.end,
    );
    for (const expiry of pendingExpiries.filter((x) => x.date <= year.end)) {
      running -= expiry.minutes;
      pendingExpiries.splice(pendingExpiries.indexOf(expiry), 1);
    }
    const policy = input.policyAt(year.end) ?? input.policyAt(year.start);
    years.push({
      start: year.start,
      end: year.end,
      endBalanceMinutes: running,
      negativeBalanceLimitMinutes: policy?.negativeBalanceLimitMinutes ?? 0,
    });
    if (year.end >= input.through) break;
    // Years stay contiguous even when a policy version moves the leave-year start.
    const nextStart = addDays(year.end, 1);
    year = { start: nextStart, end: yearOf(nextStart).end };
  }
  return years;
}

/**
 * Whether adding `candidate` (leave as negative minutes on its dates) keeps every leave year
 * within its negative-balance limit — or at least makes no year that is already short worse.
 */
export function leaveYearBalanceCheck(input: {
  accountId: string;
  entries: readonly ProjectionEntry[];
  candidate: readonly ProjectionEntry[];
  today: Date;
  policyAt: (date: Date) => LeavePolicy | null;
}) {
  const dates = [...input.entries, ...input.candidate].map((e) =>
    e.effectiveDate.getTime(),
  );
  const through = new Date(Math.max(input.today.getTime(), ...dates));
  const before = projectLeaveYears({ ...input, through });
  const after = projectLeaveYears({
    ...input,
    entries: [...input.entries, ...input.candidate],
    through,
  });
  const firstDate = new Date(
    Math.min(...input.candidate.map((e) => e.effectiveDate.getTime())),
  );
  const index = Math.max(
    0,
    after.findIndex((y) => y.start <= firstDate && firstDate <= y.end),
  );
  const shortfall = after.find(
    (year, i) =>
      year.endBalanceMinutes < -year.negativeBalanceLimitMinutes &&
      year.endBalanceMinutes < (before[i]?.endBalanceMinutes ?? 0),
  );
  return {
    leaveYear: { start: after[index]!.start, end: after[index]!.end },
    availableMinutes: before[index]!.endBalanceMinutes,
    availableAfterMinutes: after[index]!.endBalanceMinutes,
    negativeBalanceLimitMinutes: after[index]!.negativeBalanceLimitMinutes,
    sufficient: !shortfall,
    shortLeaveYear: shortfall
      ? { start: shortfall.start, end: shortfall.end }
      : null,
  };
}
