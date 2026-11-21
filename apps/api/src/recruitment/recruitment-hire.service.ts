import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  requireActor,
} from '../common/domain-support.js';
import { formatRateAmount } from '../compensation/compensation-domain.js';
import { CompensationService } from '../compensation/compensation.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeAccessService } from '../employee/employee-access.service.js';
import { EmployeeDomainService } from '../employee/employee-domain.service.js';
import { lockEmployeeLifecycle } from '../employee/employee-lifecycle-support.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import {
  conflict,
  isUniqueViolation,
  RecruitmentClock,
  recordActivity,
  recruitmentToday,
  writeRecruitmentAudit,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import { invalid, openingAfterHire } from './recruitment-domain.js';
import { hireShape } from './recruitment-shapes.js';

export interface ConvertToEmployeeInput {
  /** Reuse this existing employee (e.g. a returning employee); never inferred silently. */
  existingEmployeeId?: string | null;
  /** Create a new person even though an employee with the candidate's email exists. */
  confirmNewPerson?: boolean;
  /** Defaults: primary for a new employee, not primary for an internal move. */
  isPrimary?: boolean;
  managerAssignmentId?: string | null;
  /** Initialize the assignment's compensation from the accepted offer (Phase 9 rules). */
  initializeCompensation?: boolean;
  payGroupId?: string | null;
}

/**
 * Phase 13 — Convert to Employee: the one explicit, transactional hand-off from Recruitment
 * to Core HR.
 *
 * In one transaction it locks the opening and the application (the shared order), validates
 * the accepted offer, the opening's remaining openings and that no hire exists (the database
 * also enforces one hire per application, offer and assignment), then:
 *   1. reuses the internal candidate's Employee, or an explicitly chosen existing Employee, or
 *      creates the Person and Employee through Core HR's EmployeeDomainService (refusing to
 *      create a duplicate when an employee with the candidate's email exists, unless HR
 *      confirms);
 *   2. creates the EmploymentAssignment on the offered position through Core HR (its own
 *      occupancy, primary and manager rules apply);
 *   3. optionally initializes compensation through the Compensation domain (its own
 *      authorization, compensation.manage, and rules apply);
 *   4. records the permanent RecruitmentHire link, marks the application HIRED (entering the
 *      Hired stage), counts the hire on the opening (FILLED when full) and audits it.
 *
 * Authorization: recruitment.hire on the opening, and Core HR's employee.manage on the offered
 * position. Recruitment never writes Core HR tables itself. Onboarding starts separately
 * (Phase 14) from the created employee and assignment.
 */
@Injectable()
export class RecruitmentHireService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
    private readonly applications: RecruitmentApplicationService,
    private readonly employees: EmployeeDomainService,
    private readonly employeeAccess: EmployeeAccessService,
    private readonly compensation: CompensationService,
  ) {}

  async convert(
    applicationId: string,
    input: ConvertToEmployeeInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    try {
      return await this.prisma.$transaction(
        (tx) => this.convertIn(tx, actor, applicationId, input, context),
        { timeout: 60_000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'RECRUITMENT_ALREADY_HIRED',
          'This application was already converted to an employee.',
        );
      }
      throw error;
    }
  }

  private async convertIn(
    tx: Tx,
    actor: string,
    applicationId: string,
    input: ConvertToEmployeeInput,
    context: RecruitmentRequestContext,
  ) {
    const application = await this.applications.lockedForManage(
      tx,
      actor,
      applicationId,
      'recruitment.hire',
    );
    if (application.access.view !== 'FULL')
      throw new NotFoundException('Application not found.');
    if (await tx.recruitmentHire.findUnique({ where: { applicationId } })) {
      throw conflict(
        'RECRUITMENT_ALREADY_HIRED',
        'This application was already converted to an employee.',
      );
    }
    if (application.status !== 'OFFERED') {
      throw conflict(
        'RECRUITMENT_HIRE_NOT_READY',
        'Only an application with an accepted offer is converted.',
        {
          status: application.status,
        },
      );
    }
    const offer = await tx.recruitmentOffer.findFirst({
      where: { applicationId, status: 'ACCEPTED' },
    });
    if (!offer) {
      throw conflict(
        'RECRUITMENT_HIRE_NOT_READY',
        'The candidate has not accepted an offer.',
      );
    }
    const opening = await tx.jobOpening.findUniqueOrThrow({
      where: { id: application.openingId },
      include: { organization: { select: { timezone: true } } },
    });
    if (
      opening.status !== 'OPEN' ||
      opening.hiredCount >= opening.openingCount
    ) {
      throw conflict(
        opening.hiredCount >= opening.openingCount
          ? 'RECRUITMENT_OPENING_FILLED'
          : 'RECRUITMENT_OPENING_NOT_OPEN',
        opening.hiredCount >= opening.openingCount
          ? 'Every opening of this requisition is already filled; add an opening first.'
          : 'The opening is not open.',
        {
          status: opening.status,
          openingCount: opening.openingCount,
          hiredCount: opening.hiredCount,
        },
      );
    }
    // Core HR's own authorization for creating employment on the offered position.
    await this.employeeAccess.assertPosition(
      actor,
      offer.positionId,
      'employee.manage',
      tx,
    );
    const candidate = application.candidate;
    const now = this.clock.now();
    const today = recruitmentToday(now, opening.organization.timezone);
    const auditContext = { ...context, actorUserId: actor };

    // 1. The Person and Employee.
    let employeeId: string;
    let personId: string;
    let createdEmployee = false;
    const reuseId =
      candidate.internalEmployeeId ?? input.existingEmployeeId ?? null;
    if (
      candidate.internalEmployeeId &&
      input.existingEmployeeId &&
      input.existingEmployeeId !== candidate.internalEmployeeId
    ) {
      invalid(
        'RECRUITMENT_HIRE_EMPLOYEE_MISMATCH',
        'An internal candidate is hired as their own employee record.',
      );
    }
    if (reuseId) {
      // Batch 5A: the employee's lifecycle lock first (the order every lifecycle change takes),
      // so a termination, inactivation or rehire cannot interleave with this conversion.
      await lockEmployeeLifecycle(tx, reuseId);
      const employee = await tx.employee.findUnique({ where: { id: reuseId } });
      if (!employee || employee.archivedAt)
        throw new NotFoundException('Employee not found.');
      // K5: a recruiter-selected existing employee is attached only by someone who can already
      // see them (employee.read through their employment) or a System administrator; anyone
      // else gets the same 404 as a missing id. An internal candidate is converted into their
      // own record (they applied as that employee).
      if (reuseId !== candidate.internalEmployeeId) {
        await this.employeeAccess.authorizeAttach(
          actor,
          employee,
          offer.positionId,
          undefined,
          tx,
        );
      }
      if (employee.status === 'TERMINATED') {
        throw conflict(
          'RECRUITMENT_HIRE_EMPLOYEE_TERMINATED',
          'The employee is terminated; rehire them in Core HR before converting.',
        );
      }
      employeeId = employee.id;
      personId = employee.personId;
    } else {
      const matches = await this.possibleExistingEmployees(
        tx,
        actor,
        candidate.normalizedEmail,
        opening.organizationId,
      );
      if (matches.total > 0 && !input.confirmNewPerson) {
        throw conflict(
          'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE',
          'An employee with this email already exists. Choose that employee or confirm a new person.',
          { matches: matches.visible },
        );
      }
      const person = await this.employees.createPerson(
        {
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          preferredName: candidate.preferredName,
          personalEmail: candidate.email,
          phone: candidate.phone,
        },
        auditContext,
        tx,
      );
      const employee = await this.employees.createEmployee(
        { personId: person.id, hireDate: offer.startDate },
        auditContext,
        tx,
      );
      employeeId = employee.id;
      personId = person.id;
      createdEmployee = true;
    }
    const actorEmployee = application.access.user.employeeId;
    if (actorEmployee && actorEmployee === employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'RECRUITMENT_SELF_ACCESS',
          'You cannot hire yourself.',
        ),
      );
    }

    // 2. The assignment, through Core HR.
    if (input.managerAssignmentId) {
      const manager = await tx.employmentAssignment.findUnique({
        where: { id: input.managerAssignmentId },
        select: { positionId: true },
      });
      if (!manager)
        throw new NotFoundException('Manager assignment not found.');
      await this.employeeAccess.assertPosition(
        actor,
        manager.positionId,
        'employee.read',
        tx,
      );
    }
    const assignment = await this.employees.createAssignment(
      {
        employeeId,
        positionId: offer.positionId,
        employmentType: offer.employmentType,
        status:
          offer.startDate.getTime() <= today.getTime() ? 'ACTIVE' : 'PLANNED',
        startDate: offer.startDate,
        isPrimary: input.isPrimary ?? createdEmployee,
        managerAssignmentId: input.managerAssignmentId ?? null,
      },
      auditContext,
      tx,
    );

    // 3. Optional compensation, through the Compensation domain.
    let compensationRecordId: string | null = null;
    if (input.initializeCompensation) {
      const record = await this.compensation.create(
        assignment.id,
        {
          payBasis: offer.payBasis,
          rateAmount: formatRateAmount(offer.rateAmount),
          currency: offer.currency,
          effectiveFrom: formatDate(offer.startDate),
          payGroupId: input.payGroupId ?? undefined,
          reason: 'Initial compensation from the accepted offer',
        },
        auditContext,
        tx,
      );
      compensationRecordId = record.id;
    }

    // 4. The permanent link and the recruitment-side effects.
    const hire = await tx.recruitmentHire.create({
      data: {
        organizationId: application.organizationId,
        applicationId,
        offerId: offer.id,
        candidateId: candidate.id,
        openingId: opening.id,
        personId,
        employeeId,
        employmentAssignmentId: assignment.id,
        compensationRecordId,
        internalCandidate: candidate.internalEmployeeId !== null,
        createdEmployee,
        convertedByUserId: actor,
        convertedAt: now,
      },
    });
    const hiredStage = await tx.recruitmentStage.findFirst({
      where: {
        organizationId: application.organizationId,
        kind: 'HIRED',
        archivedAt: null,
      },
      orderBy: { sortOrder: 'asc' },
    });
    const fromStage = await tx.recruitmentStage.findUniqueOrThrow({
      where: { id: application.stageId },
    });
    await tx.recruitmentApplication.update({
      where: { id: applicationId },
      data: {
        status: 'HIRED',
        ...(hiredStage && hiredStage.id !== fromStage.id
          ? { stageId: hiredStage.id, stageEnteredAt: now }
          : {}),
      },
    });
    if (hiredStage && hiredStage.id !== fromStage.id) {
      await tx.recruitmentStageTransition.create({
        data: {
          applicationId,
          fromStageId: fromStage.id,
          fromStageName: fromStage.name,
          toStageId: hiredStage.id,
          toStageName: hiredStage.name,
          actorUserId: actor,
        },
      });
    }
    const next = openingAfterHire(opening);
    await tx.jobOpening.update({
      where: { id: opening.id },
      data: { hiredCount: next.hiredCount, status: next.status },
    });
    await tx.jobOpeningEvent.create({
      data: {
        openingId: opening.id,
        type:
          next.status !== opening.status ? 'STATUS_CHANGED' : 'HIRE_RECORDED',
        fromStatus: next.status !== opening.status ? opening.status : null,
        toStatus: next.status !== opening.status ? next.status : null,
        changedFields: ['hiredCount'],
        actorUserId: actor,
      },
    });
    if (!candidate.personId) {
      await tx.recruitmentCandidate.update({
        where: { id: candidate.id },
        data: { personId },
      });
    }
    await recordActivity(tx, {
      organizationId: application.organizationId,
      candidateId: candidate.id,
      applicationId,
      type: 'HIRED',
      summary: `Hired for ${opening.title}`,
      relatedId: hire.id,
      actorUserId: actor,
    });
    await writeRecruitmentAudit(this.audit, tx, {
      action: 'RECRUITMENT_HIRE_CONVERTED',
      entityType: 'RecruitmentHire',
      entityId: hire.id,
      context,
      metadata: {
        organizationId: application.organizationId,
        applicationId,
        offerId: offer.id,
        openingId: opening.id,
        employeeId,
        employmentAssignmentId: assignment.id,
        compensationRecordId,
        createdEmployee,
        internalCandidate: hire.internalCandidate,
        openingStatus: next.status,
      },
    });
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { employeeNumber: true },
    });
    return {
      ...hireShape(hire)!,
      employeeNumber: employee.employeeNumber,
      assignment: {
        id: assignment.id,
        status: assignment.status,
        startDate: formatDate(assignment.startDate),
      },
      opening: {
        id: opening.id,
        status: next.status,
        hiredCount: next.hiredCount,
        openingCount: opening.openingCount,
      },
    };
  }

  /**
   * Employees with the candidate's email, to avoid a duplicate person. Only two kinds count
   * (Batch 5E, R1): an employee with a non-cancelled assignment in the hiring organization, and an
   * employee the recruiter may see (employee.read through their employment, or SYSTEM). Employees
   * of other organizations the recruiter cannot see never cause a conflict, so the conversion
   * reveals nothing about them (Batch 5A disclosed no identifiers, but still answered 409).
   * Identifiers are returned only for visible matches.
   */
  private async possibleExistingEmployees(
    tx: Tx,
    actor: string,
    email: string | null,
    hiringOrganizationId: string,
  ) {
    if (!email) return { visible: [], total: 0 };
    const rows = await tx.employee.findMany({
      where: {
        archivedAt: null,
        person: {
          OR: [
            { personalEmail: { equals: email, mode: 'insensitive' } },
            { user: { is: { email: { equals: email, mode: 'insensitive' } } } },
          ],
        },
      },
      select: {
        id: true,
        employeeNumber: true,
        status: true,
        assignments: {
          where: {
            status: { not: 'CANCELLED' },
            position: { organizationId: hiringOrganizationId },
          },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { id: 'asc' },
      take: 20,
    });
    const visible = [];
    let total = 0;
    for (const row of rows) {
      // Every row is checked the same way, whichever organization it belongs to.
      const canSee = await this.employeeAccess.canEmployee(
        actor,
        row.id,
        'employee.read',
        tx,
      );
      if (canSee || row.assignments.length > 0) total += 1;
      if (canSee && visible.length < 5)
        visible.push({
          employeeId: row.id,
          employeeNumber: row.employeeNumber,
          status: row.status,
        });
    }
    return { visible, total };
  }
}
