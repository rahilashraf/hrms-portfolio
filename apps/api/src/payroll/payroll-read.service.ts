import { Injectable, NotFoundException } from '@nestjs/common';
import { formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PayrollAccessService } from './payroll-access.service.js';
import { PayrollSeparationService } from './payroll-separation.service.js';
import type { PayrollRunListQueryDto } from './payroll.dto.js';

const money = (value: Prisma.Decimal | null | undefined) =>
  value === null || value === undefined ? null : value.toFixed(2);
const date = (value: Date | null | undefined) =>
  value ? formatDate(value) : null;

/**
 * Phase 10 Batch 10 — payroll read models for administrators (payroll.read in the run's
 * organization). Every figure is read from the run's own stored lines, totals and snapshots,
 * never recomputed from live sources: a finalized run reads the same forever. Net pay is not
 * reported while statutory deductions are not calculated.
 */
@Injectable()
export class PayrollReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly separation: PayrollSeparationService,
  ) {}

  async runs(userId: string, query: PayrollRunListQueryDto) {
    await this.access.assert(userId, 'payroll.read', query.organizationId);
    const rows = await this.prisma.payrollRun.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.payGroupId ? { payGroupId: query.payGroupId } : {}),
        ...(query.payrollPeriodId
          ? { payrollPeriodId: query.payrollPeriodId }
          : {}),
      },
      include: {
        payGroup: { select: { id: true, code: true, name: true } },
        period: true,
        _count: { select: { employees: true } },
      },
      orderBy: [{ period: { periodStart: 'desc' } }, { createdAt: 'desc' }],
      take: 200,
    });
    return {
      // M2: the organization's dual-control policy, shown on the payroll pages.
      dualControl: await this.separation.dualControl(
        this.prisma,
        query.organizationId,
      ),
      items: rows.map((run) => ({
        ...this.runSummary(run),
        employeeCount: run._count.employees,
      })),
    };
  }

  async run(userId: string, runId: string) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: runId },
      include: {
        payGroup: { select: { id: true, code: true, name: true } },
        period: true,
        organization: { select: { id: true, name: true } },
        employees: {
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
          include: {
            assignments: { orderBy: { positionName: 'asc' } },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payroll run not found.');
    await this.access.assert(userId, 'payroll.read', run.organizationId);
    const issues = await this.prisma.payrollValidationIssue.groupBy({
      by: ['severity'],
      where: { payrollRunId: run.id },
      _count: { _all: true },
    });
    const actions = await this.access.actions(userId, run.organizationId);
    const counts = Object.fromEntries(
      issues.map((row) => [row.severity, row._count._all]),
    );
    const live = run.status !== 'FINALIZED' && run.status !== 'VOIDED';
    // M2: the same separation checks the lifecycle applies (the server stays authoritative).
    const dualControl = await this.separation.dualControl(
      this.prisma,
      run.organizationId,
    );
    const attribution = await this.separation.runOf(this.prisma, run.id);
    const ownPay =
      (await this.prisma.payrollRunEmployee.count({
        where: {
          payrollRunId: run.id,
          employee: { person: { user: { id: userId } } },
        },
      })) > 0;
    const canApproveStatus =
      actions.canApprove &&
      run.status === 'CALCULATED' &&
      (counts.ERROR ?? 0) === 0;
    const approveBlockedReason = !canApproveStatus
      ? null
      : ownPay
        ? 'OWN_PAY'
        : await this.separation.approvalRefusal(
            this.prisma,
            attribution,
            userId,
            dualControl,
          );
    const canFinalizeStatus = actions.canFinalize && run.status === 'APPROVED';
    const finalizeBlockedReason = !canFinalizeStatus
      ? null
      : ownPay
        ? 'OWN_PAY'
        : await this.separation.finalizationRefusal(
            this.prisma,
            attribution,
            userId,
            dualControl,
          );
    const people = await this.peopleNames([
      run.calculatedByUserId,
      run.approvedByUserId,
      run.finalizedByUserId,
    ]);
    const person = (id: string | null) =>
      id ? { userId: id, name: people.get(id) ?? null } : null;
    return {
      ...this.runSummary(run),
      organization: run.organization,
      dualControl,
      calculatedBy: person(run.calculatedByUserId),
      approvedBy: person(run.approvedByUserId),
      finalizedBy: person(run.finalizedByUserId),
      issueCounts: {
        ERROR: counts.ERROR ?? 0,
        WARNING: counts.WARNING ?? 0,
        INFO: counts.INFO ?? 0,
      },
      employees: run.employees.map((employee) => ({
        id: employee.id,
        employeeId: employee.employeeId,
        employeeNumber: employee.employeeNumber,
        displayName: employee.displayName,
        grossAmount: money(employee.grossAmount),
        deductionAmount: money(employee.deductionAmount),
        employerContributionAmount: money(employee.employerContributionAmount),
        assignments: employee.assignments.map((assignment) => ({
          id: assignment.id,
          employmentAssignmentId: assignment.employmentAssignmentId,
          positionName: assignment.positionName,
          employmentType: assignment.employmentType,
          grossAmount: money(assignment.grossAmount),
          deductionAmount: money(assignment.deductionAmount),
          employerContributionAmount: money(
            assignment.employerContributionAmount,
          ),
        })),
      })),
      actions: {
        canCalculate: actions.canCalculate && live,
        canApprove: canApproveStatus && approveBlockedReason === null,
        approveBlockedReason,
        canFinalize: canFinalizeStatus && finalizeBlockedReason === null,
        finalizeBlockedReason,
        canVoid: actions.canManage && live,
        canAddManualLines:
          actions.canAdjust &&
          (run.status === 'DRAFT' || run.status === 'CALCULATED'),
        canAdjust: actions.canAdjust,
      },
    };
  }

  async issues(userId: string, runId: string) {
    const run = await this.runOrganization(runId);
    await this.access.assert(userId, 'payroll.read', run.organizationId);
    const rows = await this.prisma.payrollValidationIssue.findMany({
      where: { payrollRunId: runId },
      include: {
        runEmployee: { select: { displayName: true, employeeNumber: true } },
        runAssignment: {
          select: { positionName: true, employmentAssignmentId: true },
        },
      },
      orderBy: [{ severity: 'asc' }, { code: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      items: rows.map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        metadata: issue.metadata,
        payrollRunEmployeeId: issue.payrollRunEmployeeId,
        payrollRunAssignmentId: issue.payrollRunAssignmentId,
        employee: issue.runEmployee,
        assignment: issue.runAssignment,
      })),
    };
  }

  /** One employee of a run with every line and the snapshots they were calculated from. */
  async runEmployee(userId: string, runId: string, runEmployeeId: string) {
    const run = await this.runOrganization(runId);
    await this.access.assert(userId, 'payroll.read', run.organizationId);
    return this.employeeDetail(runId, runEmployeeId);
  }

  async employeeDetail(runId: string, runEmployeeId: string) {
    const employee = await this.prisma.payrollRunEmployee.findFirst({
      where: { id: runEmployeeId, payrollRunId: runId },
      include: {
        assignments: {
          orderBy: { positionName: 'asc' },
          include: {
            earningLines: {
              orderBy: [
                { workDate: 'asc' },
                { periodFrom: 'asc' },
                { createdAt: 'asc' },
              ],
            },
            deductionLines: { orderBy: { createdAt: 'asc' } },
            contributionLines: { orderBy: { createdAt: 'asc' } },
            compensationSnapshots: { orderBy: { effectiveFrom: 'asc' } },
            timeSnapshots: { orderBy: { workDate: 'asc' } },
            leaveSnapshots: { orderBy: { date: 'asc' } },
            presenceSnapshots: { orderBy: { signedInAt: 'asc' } },
            benefitSnapshots: {
              orderBy: [{ planCode: 'asc' }, { coveredFrom: 'asc' }],
            },
            validationIssues: {
              orderBy: [{ severity: 'asc' }, { code: 'asc' }],
            },
          },
        },
      },
    });
    if (!employee)
      throw new NotFoundException('Payroll run employee not found.');
    return {
      id: employee.id,
      employeeId: employee.employeeId,
      employeeNumber: employee.employeeNumber,
      displayName: employee.displayName,
      grossAmount: money(employee.grossAmount),
      deductionAmount: money(employee.deductionAmount),
      employerContributionAmount: money(employee.employerContributionAmount),
      assignments: employee.assignments.map((assignment) => ({
        id: assignment.id,
        employmentAssignmentId: assignment.employmentAssignmentId,
        positionName: assignment.positionName,
        employmentType: assignment.employmentType,
        assignmentStartDate: date(assignment.assignmentStartDate),
        assignmentEndDate: date(assignment.assignmentEndDate),
        timezone: assignment.timezone,
        sourceFingerprint: assignment.sourceFingerprint,
        grossAmount: money(assignment.grossAmount),
        deductionAmount: money(assignment.deductionAmount),
        employerContributionAmount: money(
          assignment.employerContributionAmount,
        ),
        earnings: assignment.earningLines.map((line) => ({
          id: line.id,
          origin: line.origin,
          type: line.type,
          description: line.description,
          workDate: date(line.workDate),
          periodFrom: date(line.periodFrom),
          periodTo: date(line.periodTo),
          quantity: line.quantity?.toString() ?? null,
          quantityUnit: line.quantityUnit,
          rateAmount: line.rateAmount?.toFixed(4) ?? null,
          amount: money(line.amount),
          currency: line.currency,
          calculationRule: line.calculationRule,
          calculationRuleVersion: line.calculationRuleVersion,
          reason: line.reason,
          reversesLineId: line.reversesLineId,
          payrollAdjustmentId: line.payrollAdjustmentId,
          compensationSnapshotId: line.compensationSnapshotId,
          timeSnapshotId: line.timeSnapshotId,
          leaveSnapshotId: line.leaveSnapshotId,
        })),
        deductions: assignment.deductionLines.map((line) => ({
          id: line.id,
          category: line.category,
          code: line.code,
          description: line.description,
          amount: money(line.amount),
          currency: line.currency,
          reason: line.reason,
          reversesLineId: line.reversesLineId,
          payrollAdjustmentId: line.payrollAdjustmentId,
        })),
        employerContributions: assignment.contributionLines.map((line) => ({
          id: line.id,
          category: line.category,
          code: line.code,
          description: line.description,
          amount: money(line.amount),
          currency: line.currency,
          reason: line.reason,
          reversesLineId: line.reversesLineId,
        })),
        snapshots: {
          compensation: assignment.compensationSnapshots.map((row) => ({
            id: row.id,
            compensationRecordId: row.compensationRecordId,
            payBasis: row.payBasis,
            rateAmount: row.rateAmount.toFixed(4),
            salaryArrangement: row.salaryArrangement,
            salaryMonthlyAmount: row.salaryMonthlyAmount?.toFixed(4) ?? null,
            salaryPaidMonths: row.salaryPaidMonths,
            salaryContractAmount: row.salaryContractAmount?.toFixed(4) ?? null,
            salaryPeriodStart: date(row.salaryPeriodStart),
            salaryPeriodEnd: date(row.salaryPeriodEnd),
            currency: row.currency,
            effectiveFrom: date(row.effectiveFrom),
            effectiveTo: date(row.effectiveTo),
            payGroupId: row.payGroupId,
          })),
          time: assignment.timeSnapshots.map((row) => ({
            id: row.id,
            timePeriodId: row.timePeriodId,
            timesheetId: row.timesheetId,
            timesheetSegmentId: row.timesheetSegmentId,
            timesheetVersion: row.timesheetVersion,
            finalizationStatus: row.finalizationStatus,
            workDate: date(row.workDate),
            approvedWorkedMinutes: row.approvedWorkedMinutes,
          })),
          leave: assignment.leaveSnapshots.map((row) => ({
            id: row.id,
            leaveRequestId: row.leaveRequestId,
            leaveRequestDayId: row.leaveRequestDayId,
            leaveTypeCode: row.leaveTypeCode,
            classification: row.classification,
            date: date(row.date),
            minutes: row.minutes,
            scheduledShiftRevisionIds: row.scheduledShiftRevisionIds,
          })),
          presence: assignment.presenceSnapshots.map((row) => ({
            id: row.id,
            attendanceSignInId: row.attendanceSignInId,
            signedInAt: row.signedInAt.toISOString(),
            workDate: date(row.workDate),
            scheduledShiftRevisionId: row.scheduledShiftRevisionId,
          })),
          benefits: assignment.benefitSnapshots.map((row) => ({
            id: row.id,
            benefitEnrollmentId: row.benefitEnrollmentId,
            planCode: row.planCode,
            planName: row.planName,
            benefitType: row.benefitType,
            optionCode: row.optionCode,
            coverageLevel: row.coverageLevel,
            rateId: row.rateId,
            frequency: row.frequency,
            employeeAmount: money(row.employeeAmount),
            employerAmount: money(row.employerAmount),
            currency: row.currency,
            employerContributionTaxable: row.employerContributionTaxable,
            coveredFrom: date(row.coveredFrom),
            coveredTo: date(row.coveredTo),
          })),
        },
        issues: assignment.validationIssues.map((issue) => ({
          id: issue.id,
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
          metadata: issue.metadata,
        })),
      })),
    };
  }

  private async runOrganization(runId: string) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: runId },
      select: { id: true, organizationId: true },
    });
    if (!run) throw new NotFoundException('Payroll run not found.');
    return run;
  }

  /** Display names of the run's actors (preferred / first and last name; null when absent). */
  private async peopleNames(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    const users = wanted.length
      ? await this.prisma.user.findMany({
          where: { id: { in: wanted } },
          select: {
            id: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        })
      : [];
    return new Map(
      users.map((user) => {
        const first = user.person?.preferredName ?? user.person?.firstName;
        const name = [first, user.person?.lastName].filter(Boolean).join(' ');
        return [user.id, name || null] as const;
      }),
    );
  }

  runSummary(
    run: Prisma.PayrollRunGetPayload<{
      include: {
        payGroup: { select: { id: true; code: true; name: true } };
        period: true;
      };
    }>,
  ) {
    return {
      id: run.id,
      organizationId: run.organizationId,
      status: run.status,
      currency: run.currency,
      payGroup: run.payGroup,
      period: {
        id: run.period.id,
        periodStart: formatDate(run.period.periodStart),
        periodEnd: formatDate(run.period.periodEnd),
        payDate: formatDate(run.period.payDate),
        status: run.period.status,
        timezone: run.period.timezone,
      },
      calculatedAt: run.calculatedAt?.toISOString() ?? null,
      calculatedByUserId: run.calculatedByUserId,
      calculationVersion: run.calculationVersion,
      sourceFingerprint: run.sourceFingerprint,
      approvedAt: run.approvedAt?.toISOString() ?? null,
      approvedByUserId: run.approvedByUserId,
      finalizedAt: run.finalizedAt?.toISOString() ?? null,
      finalizedByUserId: run.finalizedByUserId,
      voidedAt: run.voidedAt?.toISOString() ?? null,
      voidReason: run.voidReason,
      statutoryStatus: run.statutoryStatus,
      totals: {
        grossAmount: money(run.grossAmount),
        deductionAmount: money(run.deductionAmount),
        employerContributionAmount: money(run.employerContributionAmount),
        // Net pay is not legally meaningful until statutory deductions exist.
        netAmount: null,
        netStatus:
          run.statutoryStatus === 'CALCULATED'
            ? 'CALCULATED'
            : 'STATUTORY_NOT_CALCULATED',
      },
    };
  }
}
