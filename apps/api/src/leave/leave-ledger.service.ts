import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { LeaveLedgerEntry } from '../generated/prisma/client.js';
import { LeaveAccessService } from './leave-access.service.js';
import {
  formatDate,
  jsonValue,
  leaveError,
  localDateOf,
  parseDateOnly,
  requireActor,
  type LeaveClient,
  type LeaveRequestContext,
} from './leave-common.js';
import {
  MANUALLY_REVERSIBLE_TYPES,
  type LeaveBalance,
} from './leave-ledger.js';
import type { LeaveAdjustmentDto, ReverseLedgerEntryDto } from './leave.dto.js';

type Tx = Prisma.TransactionClient;

export interface LedgerPosting {
  account: {
    id: string;
    employeeId: string;
    employmentAssignmentId: string;
    leaveTypeId: string;
  };
  entryType: LeaveLedgerEntry['entryType'];
  amountMinutes: number;
  effectiveDate: Date;
  sourceType: LeaveLedgerEntry['sourceType'];
  idempotencyKey: string;
  policyId?: string | null;
  leaveRequestId?: string | null;
  leaveRequestDayId?: string | null;
  reversesEntryId?: string | null;
  reason?: string | null;
  createdByUserId?: string | null;
}

/**
 * Phase 8 — leave accounts and the append-only ledger. Every balance-changing write locks the
 * account row (FOR UPDATE) and checks its deterministic idempotency key while holding it, so a
 * retried job or request never posts twice; the database unique key is the backstop and
 * triggers reject any UPDATE or DELETE of history.
 */
@Injectable()
export class LeaveLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LeaveAccessService,
    private readonly audit: AuditService,
  ) {}

  // ─── Accounts ──────────────────────────────────────────────────────────────

  /** Creates the account of an assignment and leave type if missing; never duplicates. */
  async ensureAccount(
    tx: Tx,
    input: {
      employeeId: string;
      employmentAssignmentId: string;
      leaveTypeId: string;
    },
  ) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "LeaveAccount" ("id", "employeeId", "employmentAssignmentId", "leaveTypeId")
      VALUES (gen_random_uuid(), ${input.employeeId}::uuid, ${input.employmentAssignmentId}::uuid, ${input.leaveTypeId}::uuid)
      ON CONFLICT ("employmentAssignmentId", "leaveTypeId") DO NOTHING`);
    return tx.leaveAccount.findUniqueOrThrow({
      where: {
        employmentAssignmentId_leaveTypeId: {
          employmentAssignmentId: input.employmentAssignmentId,
          leaveTypeId: input.leaveTypeId,
        },
      },
    });
  }

  /** First lock of the shared order (assignment → account → request); same as Phase 7. */
  async lockAssignment(tx: Tx, assignmentId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "EmploymentAssignment" WHERE "id" = ${assignmentId}::uuid FOR NO KEY UPDATE`,
    );
  }

  async lockAccount(tx: Tx, accountId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "LeaveAccount" WHERE "id" = ${accountId}::uuid FOR UPDATE`,
    );
  }

  // ─── Posting ───────────────────────────────────────────────────────────────

  /**
   * Posts one entry unless its idempotency key already exists. The caller holds the account
   * lock. Returns the new entry, or the existing one with `created: false`.
   */
  async post(tx: Tx, posting: LedgerPosting) {
    const existing = await tx.leaveLedgerEntry.findUnique({
      where: { idempotencyKey: posting.idempotencyKey },
    });
    if (existing) {
      if (existing.accountId !== posting.account.id) {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_IDEMPOTENCY_KEY_REUSED',
            'The idempotency key was used for another account.',
          ),
        );
      }
      return { entry: existing, created: false };
    }
    const entry = await tx.leaveLedgerEntry.create({
      data: {
        accountId: posting.account.id,
        employeeId: posting.account.employeeId,
        employmentAssignmentId: posting.account.employmentAssignmentId,
        leaveTypeId: posting.account.leaveTypeId,
        entryType: posting.entryType,
        amountMinutes: posting.amountMinutes,
        effectiveDate: posting.effectiveDate,
        sourceType: posting.sourceType,
        idempotencyKey: posting.idempotencyKey,
        policyId: posting.policyId ?? null,
        leaveRequestId: posting.leaveRequestId ?? null,
        leaveRequestDayId: posting.leaveRequestDayId ?? null,
        reversesEntryId: posting.reversesEntryId ?? null,
        reason: posting.reason ?? null,
        createdByUserId: posting.createdByUserId ?? null,
      },
    });
    return { entry, created: true };
  }

  /** Posts the exact negation of an entry; usage reversals keep its date and request day. */
  async postReversal(
    tx: Tx,
    original: LeaveLedgerEntry,
    input: {
      reason: string;
      sourceType: LeaveLedgerEntry['sourceType'];
      createdByUserId: string | null;
    },
  ) {
    return this.post(tx, {
      account: {
        id: original.accountId,
        employeeId: original.employeeId,
        employmentAssignmentId: original.employmentAssignmentId,
        leaveTypeId: original.leaveTypeId,
      },
      entryType: 'REVERSAL',
      amountMinutes: -original.amountMinutes,
      effectiveDate: original.effectiveDate,
      sourceType: input.sourceType,
      idempotencyKey: `reversal:${original.id}`,
      policyId: original.policyId,
      leaveRequestId: original.leaveRequestId,
      leaveRequestDayId: original.leaveRequestDayId,
      reversesEntryId: original.id,
      reason: input.reason,
      createdByUserId: input.createdByUserId,
    });
  }

  // ─── Balances ──────────────────────────────────────────────────────────────

  /** Balances of many accounts in one aggregate query, each as of its own local date. */
  async balances(
    client: LeaveClient,
    accounts: readonly { id: string; asOf: Date }[],
  ): Promise<Map<string, LeaveBalance>> {
    const result = new Map<string, LeaveBalance>();
    if (accounts.length === 0) return result;
    const rows = await client.$queryRaw<
      Array<{
        accountId: string;
        current: number;
        scheduled: number;
        available: number;
      }>
    >(Prisma.sql`
      SELECT e."accountId",
             COALESCE(SUM(e."amountMinutes") FILTER (WHERE e."effectiveDate" <= a."asOf"), 0)::int AS "current",
             COALESCE(-SUM(e."amountMinutes") FILTER (WHERE e."effectiveDate" > a."asOf" AND e."leaveRequestDayId" IS NOT NULL), 0)::int AS "scheduled",
             COALESCE(SUM(e."amountMinutes"), 0)::int AS "available"
      FROM "LeaveLedgerEntry" e
      JOIN (
        SELECT unnest(${accounts.map((a) => a.id)}::uuid[]) AS "id",
               unnest(${accounts.map((a) => formatDate(a.asOf))}::date[]) AS "asOf"
      ) a ON a."id" = e."accountId"
      GROUP BY e."accountId"`);
    for (const account of accounts) {
      result.set(account.id, {
        currentMinutes: 0,
        scheduledMinutes: 0,
        availableMinutes: 0,
      });
    }
    for (const row of rows) {
      result.set(row.accountId, {
        currentMinutes: row.current,
        scheduledMinutes: row.scheduled,
        availableMinutes: row.available,
      });
    }
    return result;
  }

  /** Requested minutes of PENDING requests per account (informational, no ledger rows). */
  async pendingMinutes(client: LeaveClient, accountIds: readonly string[]) {
    const result = new Map<string, number>();
    if (accountIds.length === 0) return result;
    const rows = await client.leaveRequest.groupBy({
      by: ['accountId'],
      where: { accountId: { in: [...accountIds] }, status: 'PENDING' },
      _sum: { requestedMinutes: true },
    });
    for (const row of rows)
      result.set(row.accountId, row._sum.requestedMinutes ?? 0);
    return result;
  }

  async balanceOf(client: LeaveClient, accountId: string, asOf: Date) {
    return (await this.balances(client, [{ id: accountId, asOf }])).get(
      accountId,
    )!;
  }

  // ─── Manual adjustments and reversals ─────────────────────────────────────

  async adjust(input: LeaveAdjustmentDto, context: LeaveRequestContext) {
    const actor = requireActor(context);
    if (input.amountMinutes === 0) {
      throw new BadRequestException('amountMinutes must not be zero.');
    }
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException('A reason is required.');
    const effectiveDate = parseDateOnly(input.effectiveDate, 'effectiveDate');
    return this.prisma.$transaction(async (tx) => {
      const { assignment, timezone } =
        await this.access.requireAssignmentPermission(
          actor,
          input.employmentAssignmentId,
          'leave.adjust',
          tx,
        );
      const type = await tx.leaveType.findUnique({
        where: { id: input.leaveTypeId },
      });
      if (!type || type.organizationId !== assignment.position.organizationId) {
        throw new NotFoundException(
          'Leave type not found for the assignment organization',
        );
      }
      if (!type.tracksBalance) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_TYPE_UNTRACKED',
            'This leave type does not track a balance.',
          ),
        );
      }
      if (
        (await this.access.employeeIdOfUser(actor, tx)) ===
        assignment.employeeId
      ) {
        throw new ForbiddenException(
          leaveError(
            403,
            'LEAVE_SELF_ADJUSTMENT',
            'You cannot adjust your own leave balance.',
          ),
        );
      }
      await this.lockAssignment(tx, assignment.id);
      const account = await this.ensureAccount(tx, {
        employeeId: assignment.employeeId,
        employmentAssignmentId: assignment.id,
        leaveTypeId: type.id,
      });
      await this.lockAccount(tx, account.id);
      const { entry, created } = await this.post(tx, {
        account,
        entryType: 'ADJUSTMENT',
        amountMinutes: input.amountMinutes,
        effectiveDate,
        sourceType: 'MANUAL',
        idempotencyKey: input.idempotencyKey
          ? `adjustment:${actor}:${input.idempotencyKey}`
          : `adjustment:${crypto.randomUUID()}`,
        reason,
        createdByUserId: actor,
      });
      if (created) {
        await this.writeAudit(tx, 'LEAVE_BALANCE_ADJUSTED', entry.id, context, {
          accountId: account.id,
          employeeId: account.employeeId,
          employmentAssignmentId: account.employmentAssignmentId,
          leaveTypeId: account.leaveTypeId,
          amountMinutes: entry.amountMinutes,
          effectiveDate: formatDate(entry.effectiveDate),
          // Phase 19: the reason stays on the ledger entry; never in the audit log.
          withReason: Boolean(reason),
        });
      }
      const asOf = localDateOf(new Date(), timezone());
      return {
        entry: this.entryShape(entry),
        created,
        balance: await this.balanceOf(tx, account.id, asOf),
      };
    });
  }

  async reverse(
    entryId: string,
    input: ReverseLedgerEntryDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException('A reason is required.');
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.leaveLedgerEntry.findUnique({
        where: { id: entryId },
      });
      if (!found) throw new NotFoundException('Ledger entry not found');
      const { timezone, assignment } =
        await this.access.requireAssignmentPermission(
          actor,
          found.employmentAssignmentId,
          'leave.adjust',
          tx,
        );
      const self = await this.access.employeeIdOfUser(actor, tx);
      if (self === assignment.employeeId) {
        throw new ForbiddenException(
          leaveError(
            403,
            'LEAVE_SELF_ADJUSTMENT',
            'You cannot adjust your own leave balance.',
          ),
        );
      }
      if (found.entryType === 'USAGE') {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_USAGE_REVERSAL_VIA_AMENDMENT',
            'Leave usage is reversed only by cancelling or shortening the approved request.',
          ),
        );
      }
      if (
        !(MANUALLY_REVERSIBLE_TYPES as readonly string[]).includes(
          found.entryType,
        )
      ) {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_ENTRY_NOT_REVERSIBLE',
            'A reversal cannot itself be reversed.',
          ),
        );
      }
      await this.lockAssignment(tx, found.employmentAssignmentId);
      await this.lockAccount(tx, found.accountId);
      const already = await tx.leaveLedgerEntry.findUnique({
        where: { reversesEntryId: entryId },
      });
      if (already) {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_ENTRY_ALREADY_REVERSED',
            'This ledger entry has already been reversed.',
            {
              reversalEntryId: already.id,
            },
          ),
        );
      }
      const { entry } = await this.postReversal(tx, found, {
        reason,
        sourceType: 'MANUAL',
        createdByUserId: actor,
      });
      await this.writeAudit(
        tx,
        'LEAVE_LEDGER_ENTRY_REVERSED',
        entry.id,
        context,
        {
          accountId: found.accountId,
          reversedEntryId: found.id,
          reversedEntryType: found.entryType,
          amountMinutes: entry.amountMinutes,
          withReason: Boolean(reason),
        },
      );
      return {
        entry: this.entryShape(entry),
        balance: await this.balanceOf(
          tx,
          found.accountId,
          localDateOf(new Date(), timezone()),
        ),
      };
    });
  }

  /** The account's full history, oldest first. Self, or leave.read/approve/adjust in scope. */
  async ledger(userId: string, accountId: string) {
    const account = await this.prisma.leaveAccount.findUnique({
      where: { id: accountId },
      include: { leaveType: true },
    });
    if (!account) throw new NotFoundException('Leave account not found');
    const { target, timezone } = await this.access.assignmentContext(
      account.employmentAssignmentId,
    );
    const grants = await this.access.grants(userId);
    const self = await this.access.employeeIdOfUser(userId);
    const isSelf = self === account.employeeId;
    if (
      !isSelf &&
      !this.access.canAny(
        grants,
        ['leave.read', 'leave.approve', 'leave.adjust'],
        target,
      )
    ) {
      throw new NotFoundException('Leave account not found');
    }
    await this.access.requireEnabled(target.organizationId);
    const entries = await this.prisma.leaveLedgerEntry.findMany({
      where: { accountId },
      include: { reversedBy: { select: { id: true } } },
      orderBy: [{ effectiveDate: 'asc' }, { postedAt: 'asc' }, { id: 'asc' }],
    });
    const asOf = localDateOf(new Date(), timezone());
    const canAdjust =
      !isSelf && this.access.can(grants, 'leave.adjust', target);
    return {
      account: {
        id: account.id,
        employeeId: account.employeeId,
        employmentAssignmentId: account.employmentAssignmentId,
        leaveType: {
          id: account.leaveType.id,
          code: account.leaveType.code,
          name: account.leaveType.name,
          classification: account.leaveType.classification,
          displayUnit: account.leaveType.displayUnit,
        },
      },
      asOf: formatDate(asOf),
      balance: await this.balanceOf(this.prisma, accountId, asOf),
      entries: entries.map((entry) => ({
        ...this.entryShape(entry),
        reversedByEntryId: entry.reversedBy?.id ?? null,
        actions: {
          canReverse:
            canAdjust &&
            !entry.reversedBy &&
            (MANUALLY_REVERSIBLE_TYPES as readonly string[]).includes(
              entry.entryType,
            ),
        },
      })),
      actions: { canAdjust },
    };
  }

  entryShape(entry: LeaveLedgerEntry) {
    return {
      id: entry.id,
      accountId: entry.accountId,
      entryType: entry.entryType,
      amountMinutes: entry.amountMinutes,
      effectiveDate: formatDate(entry.effectiveDate),
      sourceType: entry.sourceType,
      policyId: entry.policyId,
      leaveRequestId: entry.leaveRequestId,
      leaveRequestDayId: entry.leaveRequestDayId,
      reversesEntryId: entry.reversesEntryId,
      reason: entry.reason,
      createdByUserId: entry.createdByUserId,
      postedAt: entry.postedAt.toISOString(),
    };
  }

  private writeAudit(
    tx: Tx,
    action: string,
    entityId: string,
    context: LeaveRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'LeaveLedgerEntry',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      tx,
    );
  }
}
