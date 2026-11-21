import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { EffectiveGrant } from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  EmployeeSchedulePattern,
  EmployeeSchedulePatternRule,
} from '../generated/prisma/client.js';
import {
  assertAnchorMonday,
  assertRotationWeeks,
} from './schedule-recurrence.js';
import type {
  ApplyScheduleTemplateDto,
  CreateSchedulePatternDto,
  EndSchedulePatternDto,
  RecurrenceRuleDto,
  UpdateRecurrenceRuleDto,
  UpdateSchedulePatternDto,
} from './schedule-recurrence.dto.js';
import {
  ScheduleRuleSetService,
  type RuleCandidate,
} from './schedule-rule-set.service.js';
import { changed, RULE_FIELDS } from './schedule-template.service.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import { removeGeneratedDrafts } from './shift-generation.service.js';
import type { SchedulingRequestContext } from './scheduling.service.js';

type Client = Prisma.TransactionClient;
type PatternWithRules = EmployeeSchedulePattern & {
  rules: EmployeeSchedulePatternRule[];
};

const MANAGE_PATTERNS = 'schedule.manage_patterns';
const DAY_MS = 24 * 60 * 60 * 1000;

interface AssignmentAccess {
  assignment: {
    id: string;
    status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
    startDate: Date;
    endDate: Date | null;
  };
  organizationId: string;
  grants: EffectiveGrant[];
}

interface PatternPeriod {
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Phase 7 Batch 5 — effective-dated recurring schedule patterns of one EmploymentAssignment.
 * Patterns describe expected recurring work; they are never expanded into ScheduledShift rows
 * here (Batch 6 generates). Periods of one assignment never overlap, using inclusive DATE
 * semantics: a pattern ending Mar 31 and one starting Apr 1 touch without overlapping.
 *
 * Pattern rows are history. A pattern that has not started yet may be edited, re-ruled, or
 * deleted. Once started it is immutable except for being ended: its end date may be set or
 * moved earlier, never into days already past; a change of recurrence is a new pattern.
 * "Started" is judged conservatively against the latest calendar date in effect anywhere
 * (UTC+14), and "past" against the earliest (UTC−12), so no timezone's history is rewritten.
 *
 * Authorization is schedule.manage_patterns (writes) or schedule.read (reads) on the
 * assignment's position scope, through the Phase 4 scoped model.
 */
@Injectable()
export class EmployeeSchedulePatternService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly domain: SchedulingDomainService,
    private readonly rules: ScheduleRuleSetService,
    private readonly audit: AuditService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the SCHEDULING module gate. */
  readonly features: FeatureGateService;

  async listPatterns(userId: string, assignmentId: string) {
    await this.requireAssignment(userId, assignmentId, 'read', this.prisma);
    const rows = await this.prisma.employeeSchedulePattern.findMany({
      where: { employmentAssignmentId: assignmentId },
      include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map((row) => this.patternShape(row)) };
  }

  async getPattern(userId: string, assignmentId: string, patternId: string) {
    await this.requireAssignment(userId, assignmentId, 'read', this.prisma);
    return this.patternShape(
      await this.loadPattern(assignmentId, patternId, this.prisma),
    );
  }

  /** A pattern defined directly, without a template. */
  async createPattern(
    assignmentId: string,
    input: CreateSchedulePatternDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const period = this.parsePeriod(input.effectiveFrom, input.effectiveTo);
    const anchorDate = this.parseAnchor(input.anchorDate);
    assertRotationWeeks(input.rotationWeeks);
    const candidates = input.rules.map((rule) => this.rules.fromInput(rule));

    return this.prisma.$transaction(async (tx) => {
      const access = await this.requireAssignment(
        actor,
        assignmentId,
        'manage',
        tx,
        { lock: true },
      );
      await this.assertPeriodAvailable(access, period, null, tx);
      const rules = await this.rules.validate(
        access.organizationId,
        input.rotationWeeks,
        candidates,
        tx,
      );
      const pattern = await tx.employeeSchedulePattern.create({
        data: {
          employmentAssignmentId: assignmentId,
          name: this.optionalName(input.name),
          ...period,
          rotationWeeks: input.rotationWeeks,
          anchorDate,
          rules: { create: rules },
        },
        include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      });
      const shaped = this.patternShape(pattern);
      await this.writeAudit(
        tx,
        'EMPLOYEE_SCHEDULE_PATTERN_CREATED',
        pattern.id,
        context,
        { pattern: shaped },
      );
      return shaped;
    });
  }

  /**
   * Copies a template's rotation and rules into a new pattern in one transaction. The pattern
   * records the template only as provenance; later template edits never reach it.
   */
  async applyTemplate(
    assignmentId: string,
    input: ApplyScheduleTemplateDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const period = this.parsePeriod(input.effectiveFrom, input.effectiveTo);
    const anchorDate = this.parseAnchor(input.anchorDate);

    return this.prisma.$transaction(async (tx) => {
      // Template before assignment, matching the lock order of every other path; FOR SHARE
      // keeps the rule set stable while it is copied.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ScheduleTemplate" WHERE "id" = ${input.templateId}::uuid FOR SHARE`,
      );
      const access = await this.requireAssignment(
        actor,
        assignmentId,
        'manage',
        tx,
        { lock: true },
      );
      const template = await tx.scheduleTemplate.findUnique({
        where: { id: input.templateId },
        include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      });
      // Another organization's template is indistinguishable from a missing one.
      if (!template || template.organizationId !== access.organizationId) {
        throw new NotFoundException('Schedule template not found');
      }
      if (template.archivedAt) {
        throw new ConflictException('Archived templates cannot be applied.');
      }
      if (template.rules.length === 0) {
        throw new BadRequestException('The template has no rules to apply.');
      }
      await this.assertPeriodAvailable(access, period, null, tx);
      const rules = await this.rules.validate(
        access.organizationId,
        template.rotationWeeks,
        template.rules.map((rule) => this.rules.copy(rule)),
        tx,
      );
      const pattern = await tx.employeeSchedulePattern.create({
        data: {
          employmentAssignmentId: assignmentId,
          name: this.optionalName(input.name) ?? template.name,
          ...period,
          rotationWeeks: template.rotationWeeks,
          anchorDate,
          sourceTemplateId: template.id,
          rules: { create: rules },
        },
        include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      });
      const shaped = this.patternShape(pattern);
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_APPLIED',
        pattern.id,
        context,
        {
          templateId: template.id,
          templateName: template.name,
          pattern: shaped,
        },
      );
      return shaped;
    });
  }

  /** Edits a pattern that has not started yet. */
  async updatePattern(
    assignmentId: string,
    patternId: string,
    input: UpdateSchedulePatternDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const access = await this.requireAssignment(
        actor,
        assignmentId,
        'manage',
        tx,
        { lock: true },
      );
      const pattern = await this.loadPattern(assignmentId, patternId, tx);
      this.assertNotStarted(pattern);

      const period = this.parsePeriod(
        input.effectiveFrom ?? dateOnly(pattern.effectiveFrom),
        input.effectiveTo === undefined
          ? pattern.effectiveTo && dateOnly(pattern.effectiveTo)
          : input.effectiveTo,
      );
      const next = {
        name:
          input.name === undefined
            ? pattern.name
            : this.optionalName(input.name),
        ...period,
        anchorDate:
          input.anchorDate === undefined
            ? pattern.anchorDate
            : this.parseAnchor(input.anchorDate),
        rotationWeeks: input.rotationWeeks ?? pattern.rotationWeeks,
      };
      const before = this.patternShape(pattern);
      const changes = changed(
        before,
        this.patternShape({ ...pattern, ...next }),
        ['name', 'effectiveFrom', 'effectiveTo', 'anchorDate', 'rotationWeeks'],
      );
      if (Object.keys(changes).length === 0) return before;
      // Moving the start into the started window would create history by editing.
      this.assertNotStarted(next);
      if (changes.effectiveFrom || changes.effectiveTo) {
        await this.assertPeriodAvailable(access, period, patternId, tx);
      }
      if (changes.rotationWeeks) {
        assertRotationWeeks(next.rotationWeeks);
        await this.rules.validate(
          access.organizationId,
          next.rotationWeeks,
          pattern.rules.map((rule) => this.rules.fromStored(rule)),
          tx,
        );
      }
      const updated = await tx.employeeSchedulePattern.update({
        where: { id: patternId },
        data: next,
        include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      });
      await this.writeAudit(
        tx,
        'EMPLOYEE_SCHEDULE_PATTERN_UPDATED',
        patternId,
        context,
        { changes },
      );
      return this.patternShape(updated);
    });
  }

  /**
   * Sets or moves earlier a pattern's last day. The new end may not fall before the day that
   * is yesterday everywhere, so already-past history is never rewritten, and an end date can
   * only shorten a pattern: extending or changing recurrence is a new pattern. Idempotent.
   */
  async endPattern(
    assignmentId: string,
    patternId: string,
    input: EndSchedulePatternDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const effectiveTo = this.domain.parseDateOnly(
      input.effectiveTo,
      'effectiveTo',
    );
    return this.prisma.$transaction(async (tx) => {
      await this.requireAssignment(actor, assignmentId, 'manage', tx, {
        lock: true,
      });
      const pattern = await this.loadPattern(assignmentId, patternId, tx);
      if (pattern.effectiveTo?.getTime() === effectiveTo.getTime()) {
        return this.patternShape(pattern);
      }
      const { earliest } = this.today();
      if (pattern.effectiveTo && pattern.effectiveTo < earliest) {
        throw new ConflictException(
          'The pattern has already ended; its history cannot be changed.',
        );
      }
      if (pattern.effectiveTo && effectiveTo > pattern.effectiveTo) {
        throw new BadRequestException(
          'Ending can only shorten a pattern; create a new pattern to extend it.',
        );
      }
      if (effectiveTo < pattern.effectiveFrom) {
        throw new BadRequestException(
          'effectiveTo must be on or after effectiveFrom.',
        );
      }
      if (effectiveTo.getTime() < earliest.getTime() - DAY_MS) {
        throw new BadRequestException(
          'A pattern cannot be ended before yesterday; past expected work is history.',
        );
      }
      const updated = await tx.employeeSchedulePattern.update({
        where: { id: patternId },
        data: { effectiveTo },
        include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      });
      await this.writeAudit(
        tx,
        'EMPLOYEE_SCHEDULE_PATTERN_ENDED',
        patternId,
        context,
        {
          previousEffectiveTo:
            pattern.effectiveTo && dateOnly(pattern.effectiveTo),
          effectiveTo: dateOnly(effectiveTo),
        },
      );
      return this.patternShape(updated);
    });
  }

  /** Only a pattern that has not started can be removed; it never described real expected work. */
  async deletePattern(
    assignmentId: string,
    patternId: string,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await this.requireAssignment(actor, assignmentId, 'manage', tx, {
        lock: true,
      });
      const pattern = await this.loadPattern(assignmentId, patternId, tx);
      this.assertNotStarted(pattern);
      // Untouched generated drafts go with the pattern; protected ones block its removal.
      const removedGeneratedShifts = await removeGeneratedDrafts(tx, {
        sourcePatternId: patternId,
      });
      await tx.employeeSchedulePatternRule.deleteMany({
        where: { employeeSchedulePatternId: patternId },
      });
      await tx.employeeSchedulePattern.delete({ where: { id: patternId } });
      await this.writeAudit(
        tx,
        'EMPLOYEE_SCHEDULE_PATTERN_DELETED',
        patternId,
        context,
        {
          pattern: this.patternShape(pattern),
          ...(removedGeneratedShifts > 0 ? { removedGeneratedShifts } : {}),
        },
      );
      return { success: true };
    });
  }

  // ─── Rules ──────────────────────────────────────────────────────────────────

  async createRule(
    assignmentId: string,
    patternId: string,
    input: RecurrenceRuleDto,
    context: SchedulingRequestContext,
  ) {
    const candidate = this.rules.fromInput(input);
    return this.changeRules(
      assignmentId,
      patternId,
      context,
      async (pattern, access, tx) => {
        const [data] = await this.validateRules(
          access,
          pattern,
          [
            candidate,
            ...pattern.rules.map((rule) => this.rules.fromStored(rule)),
          ],
          tx,
        );
        const rule = await tx.employeeSchedulePatternRule.create({
          data: { ...data!, employeeSchedulePatternId: patternId },
        });
        const shaped = this.rules.shape(rule);
        await this.writeAudit(
          tx,
          'EMPLOYEE_SCHEDULE_PATTERN_RULE_CREATED',
          patternId,
          context,
          { rule: shaped },
        );
        return shaped;
      },
    );
  }

  async updateRule(
    assignmentId: string,
    patternId: string,
    ruleId: string,
    input: UpdateRecurrenceRuleDto,
    context: SchedulingRequestContext,
  ) {
    return this.changeRules(
      assignmentId,
      patternId,
      context,
      async (pattern, access, tx) => {
        const rule = this.findRule(pattern, ruleId);
        const candidate = this.rules.merge(rule, input);
        if (!candidate.fresh) return this.rules.shape(rule);
        const [data] = await this.validateRules(
          access,
          pattern,
          [
            candidate,
            ...pattern.rules
              .filter((other) => other.id !== ruleId)
              .map((other) => this.rules.fromStored(other)),
          ],
          tx,
        );
        const updated = await tx.employeeSchedulePatternRule.update({
          where: { id: ruleId },
          data: data!,
        });
        const after = this.rules.shape(updated);
        await this.writeAudit(
          tx,
          'EMPLOYEE_SCHEDULE_PATTERN_RULE_UPDATED',
          patternId,
          context,
          {
            ruleId,
            changes: changed(this.rules.shape(rule), after, RULE_FIELDS),
          },
        );
        return after;
      },
    );
  }

  async deleteRule(
    assignmentId: string,
    patternId: string,
    ruleId: string,
    context: SchedulingRequestContext,
  ) {
    return this.changeRules(
      assignmentId,
      patternId,
      context,
      async (pattern, _access, tx) => {
        const rule = this.findRule(pattern, ruleId);
        if (pattern.rules.length === 1) {
          throw new BadRequestException(
            'A pattern must keep at least one rule; delete the pattern instead.',
          );
        }
        const removedGeneratedShifts = await removeGeneratedDrafts(tx, {
          sourcePatternRuleId: ruleId,
        });
        await tx.employeeSchedulePatternRule.delete({ where: { id: ruleId } });
        await this.writeAudit(
          tx,
          'EMPLOYEE_SCHEDULE_PATTERN_RULE_DELETED',
          patternId,
          context,
          {
            rule: this.rules.shape(rule),
            ...(removedGeneratedShifts > 0 ? { removedGeneratedShifts } : {}),
          },
        );
        return { success: true };
      },
    );
  }

  /** Rules of a started pattern are history and cannot change. */
  private changeRules<T>(
    assignmentId: string,
    patternId: string,
    context: SchedulingRequestContext,
    change: (
      pattern: PatternWithRules,
      access: AssignmentAccess,
      tx: Client,
    ) => Promise<T>,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const access = await this.requireAssignment(
        actor,
        assignmentId,
        'manage',
        tx,
        { lock: true },
      );
      const pattern = await this.loadPattern(assignmentId, patternId, tx);
      this.assertNotStarted(pattern);
      return change(pattern, access, tx);
    });
  }

  private validateRules(
    access: AssignmentAccess,
    pattern: PatternWithRules,
    candidates: RuleCandidate[],
    tx: Client,
  ) {
    return this.rules.validate(
      access.organizationId,
      pattern.rotationWeeks,
      candidates,
      tx,
    );
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  private parsePeriod(
    from: string,
    to: string | null | undefined,
  ): PatternPeriod {
    const effectiveFrom = this.domain.parseDateOnly(from, 'effectiveFrom');
    const effectiveTo = to
      ? this.domain.parseDateOnly(to, 'effectiveTo')
      : null;
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw new BadRequestException(
        'effectiveTo must be on or after effectiveFrom.',
      );
    }
    return { effectiveFrom, effectiveTo };
  }

  private parseAnchor(value: string) {
    const anchorDate = this.domain.parseDateOnly(value, 'anchorDate');
    assertAnchorMonday(anchorDate);
    return anchorDate;
  }

  /**
   * The period must fit the assignment's own dates and must not overlap another pattern of the
   * same assignment. Callers hold the assignment row lock, so check and write cannot race.
   */
  private async assertPeriodAvailable(
    access: AssignmentAccess,
    period: PatternPeriod,
    excludePatternId: string | null,
    tx: Client,
  ) {
    const { assignment } = access;
    if (assignment.status === 'CANCELLED') {
      throw new BadRequestException(
        'A cancelled EmploymentAssignment cannot have a schedule pattern.',
      );
    }
    if (period.effectiveFrom < assignment.startDate) {
      throw new BadRequestException(
        'The pattern cannot start before the EmploymentAssignment starts.',
      );
    }
    if (
      assignment.endDate &&
      (!period.effectiveTo || period.effectiveTo > assignment.endDate)
    ) {
      throw new BadRequestException(
        'The pattern must end on or before the EmploymentAssignment end date.',
      );
    }
    const overlapping = await tx.employeeSchedulePattern.findFirst({
      where: {
        employmentAssignmentId: assignment.id,
        ...(excludePatternId ? { id: { not: excludePatternId } } : {}),
        ...(period.effectiveTo
          ? { effectiveFrom: { lte: period.effectiveTo } }
          : {}),
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: period.effectiveFrom } },
        ],
      },
      select: { id: true, effectiveFrom: true, effectiveTo: true },
    });
    if (overlapping) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SCHEDULE_PATTERN_PERIOD_OVERLAP',
        message:
          'The pattern period overlaps another pattern of this EmploymentAssignment; end that pattern first.',
        overlappingPattern: {
          id: overlapping.id,
          effectiveFrom: dateOnly(overlapping.effectiveFrom),
          effectiveTo:
            overlapping.effectiveTo && dateOnly(overlapping.effectiveTo),
        },
      });
    }
  }

  private assertNotStarted(
    pattern: Pick<EmployeeSchedulePattern, 'effectiveFrom'>,
  ) {
    if (pattern.effectiveFrom <= this.today().latest) {
      throw new ConflictException(
        'The pattern has started; it can only be ended. Create a new pattern to change recurring work.',
      );
    }
  }

  /** The earliest (UTC−12) and latest (UTC+14) calendar dates currently in effect anywhere. */
  private today() {
    const now = Date.now();
    const date = (offsetHours: number) =>
      new Date(
        new Date(now + offsetHours * 3_600_000).toISOString().slice(0, 10),
      );
    return { earliest: date(-12), latest: date(14) };
  }

  // ─── Access ─────────────────────────────────────────────────────────────────

  /**
   * Loads an assignment the actor may see through its position scope; others are reported as
   * not found. With lock, the assignment row is held FOR NO KEY UPDATE so pattern period checks
   * and writes for one assignment serialize (other modules can still reference the row).
   */
  private async requireAssignment(
    actor: string,
    assignmentId: string,
    access: 'read' | 'manage',
    client: Client,
    options: { lock?: boolean } = {},
  ): Promise<AssignmentAccess> {
    if (options.lock) {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "EmploymentAssignment" WHERE "id" = ${assignmentId}::uuid FOR NO KEY UPDATE`,
      );
    }
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        positionId: true,
        position: { select: { organizationId: true } },
      },
    });
    if (!assignment)
      throw new NotFoundException('EmploymentAssignment not found');
    const grants = (
      await this.authorization.effectiveGrants(actor, new Date(), client)
    ).filter(
      (grant) =>
        grant.permission === 'schedule.read' ||
        grant.permission === MANAGE_PATTERNS,
    );
    const target = await this.targets.resolvePosition(
      assignment.positionId,
      undefined,
      client,
    );
    if (
      !permissionIsGranted(grants, 'schedule.read', target) &&
      !permissionIsGranted(grants, MANAGE_PATTERNS, target)
    ) {
      throw new NotFoundException('EmploymentAssignment not found');
    }
    if (
      access === 'manage' &&
      !permissionIsGranted(grants, MANAGE_PATTERNS, target)
    ) {
      throw new ForbiddenException(
        'Missing permission schedule.manage_patterns for the employment assignment scope.',
      );
    }
    await this.features.require(target.organizationId, 'SCHEDULING', client);
    return {
      assignment,
      organizationId: assignment.position.organizationId,
      grants,
    };
  }

  private async loadPattern(
    assignmentId: string,
    patternId: string,
    client: Client,
  ): Promise<PatternWithRules> {
    const pattern = await client.employeeSchedulePattern.findFirst({
      where: { id: patternId, employmentAssignmentId: assignmentId },
      include: { rules: { orderBy: [...this.rules.ruleOrder] } },
    });
    if (!pattern) throw new NotFoundException('Schedule pattern not found');
    return pattern;
  }

  private findRule(pattern: PatternWithRules, ruleId: string) {
    const rule = pattern.rules.find((row) => row.id === ruleId);
    if (!rule) throw new NotFoundException('Schedule pattern rule not found');
    return rule;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private optionalName(value: string | null | undefined) {
    return value?.trim() || null;
  }

  private requireActor(context: SchedulingRequestContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }

  private patternShape(pattern: PatternWithRules) {
    return {
      id: pattern.id,
      employmentAssignmentId: pattern.employmentAssignmentId,
      name: pattern.name,
      effectiveFrom: dateOnly(pattern.effectiveFrom),
      effectiveTo: pattern.effectiveTo && dateOnly(pattern.effectiveTo),
      rotationWeeks: pattern.rotationWeeks,
      anchorDate: dateOnly(pattern.anchorDate),
      sourceTemplateId: pattern.sourceTemplateId,
      rules: pattern.rules.map((rule) => this.rules.shape(rule)),
      createdAt: pattern.createdAt.toISOString(),
      updatedAt: pattern.updatedAt.toISOString(),
    };
  }

  private writeAudit(
    client: Client,
    action: string,
    patternId: string,
    context: SchedulingRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'EmployeeSchedulePattern',
        entityId: patternId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
      client,
    );
  }
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}
