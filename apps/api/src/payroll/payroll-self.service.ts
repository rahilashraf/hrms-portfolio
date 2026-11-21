import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { domainError, formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

const Decimal = Prisma.Decimal;
const money = (value: Prisma.Decimal) => value.toFixed(2);

export const NET_PAY_EXPLANATION =
  'Net pay is not shown: statutory deductions (income tax, CPP/CPP2, EI) are not calculated by this system yet. The amounts shown are gross pay and any other deductions.';

/**
 * Phase 10 Batch 10 — employee self-service pay. Authorized by the caller's own identity (the
 * employee linked to their user), never by payroll.read: an employee sees exactly their own
 * finalized pay, and nothing of a run that is not finalized. Payslips are read from the stored
 * lines of finalized runs only; they never show validation details, fingerprints, internal
 * reasons or other employees.
 */
@Injectable()
export class PayrollSelfService {
  /** Phase 18: the PAYROLL module gate. */
  private readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  async myPay(userId: string) {
    const employeeId = await this.ownEmployeeId(userId);
    const disabled = await this.features.disabledOrganizations('PAYROLL');
    const rows = await this.prisma.payrollRunEmployee.findMany({
      where: {
        employeeId,
        run: { status: 'FINALIZED', organizationId: { notIn: [...disabled] } },
      },
      include: {
        run: {
          include: {
            period: true,
            organization: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ run: { period: { payDate: 'desc' } } }, { id: 'asc' }],
      take: 200,
    });
    return {
      netPayExplanation: NET_PAY_EXPLANATION,
      items: rows.map((row) => ({
        id: row.id,
        payrollRunId: row.payrollRunId,
        employer: row.run.organization.name,
        currency: row.run.currency,
        payDate: formatDate(row.run.period.payDate),
        periodStart: formatDate(row.run.period.periodStart),
        periodEnd: formatDate(row.run.period.periodEnd),
        grossAmount: money(row.grossAmount),
        deductionAmount: money(row.deductionAmount),
        netAmount: null,
      })),
    };
  }

  async payslip(userId: string, runEmployeeId: string) {
    const employeeId = await this.ownEmployeeId(userId);
    const row = await this.prisma.payrollRunEmployee.findFirst({
      // Someone else's (or an unfinalized) payslip does not exist for the caller.
      where: { id: runEmployeeId, employeeId, run: { status: 'FINALIZED' } },
      include: {
        run: {
          include: {
            period: true,
            payGroup: { select: { name: true } },
            organization: { select: { id: true, name: true } },
          },
        },
        assignments: {
          orderBy: { positionName: 'asc' },
          include: {
            earningLines: {
              orderBy: [
                { type: 'asc' },
                { workDate: 'asc' },
                { periodFrom: 'asc' },
                { createdAt: 'asc' },
              ],
            },
            deductionLines: { orderBy: { createdAt: 'asc' } },
            contributionLines: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Payslip not found.');
    const { run } = row;
    await this.features.require(run.organizationId, 'PAYROLL');
    let paidMinutes = new Decimal(0);
    for (const assignment of row.assignments) {
      for (const line of assignment.earningLines) {
        if (
          line.quantityUnit === 'MINUTES' &&
          line.quantity &&
          (line.type === 'REGULAR_HOURLY' || line.type === 'PAID_LEAVE')
        ) {
          paidMinutes = paidMinutes.add(line.quantity);
        }
      }
    }
    // Year to date: this employee's finalized gross in this currency, paid in the same calendar
    // year up to and including this pay date.
    const payDate = run.period.payDate;
    const yearStart = new Date(Date.UTC(payDate.getUTCFullYear(), 0, 1));
    const ytd = await this.prisma.payrollRunEmployee.aggregate({
      where: {
        employeeId,
        run: {
          status: 'FINALIZED',
          currency: run.currency,
          period: { payDate: { gte: yearStart, lte: payDate } },
        },
      },
      _sum: { grossAmount: true, deductionAmount: true },
    });
    return {
      id: row.id,
      employer: { name: run.organization.name },
      employee: {
        displayName: row.displayName,
        employeeNumber: row.employeeNumber,
      },
      payGroup: run.payGroup.name,
      period: {
        periodStart: formatDate(run.period.periodStart),
        periodEnd: formatDate(run.period.periodEnd),
        payDate: formatDate(payDate),
      },
      currency: run.currency,
      finalizedAt: run.finalizedAt?.toISOString() ?? null,
      earnings: row.assignments.flatMap((assignment) =>
        assignment.earningLines.map((line) => ({
          id: line.id,
          positionName: assignment.positionName,
          type: line.type,
          description: line.description,
          workDate: line.workDate ? formatDate(line.workDate) : null,
          periodFrom: line.periodFrom ? formatDate(line.periodFrom) : null,
          periodTo: line.periodTo ? formatDate(line.periodTo) : null,
          hours:
            line.quantityUnit === 'MINUTES' && line.quantity
              ? line.quantity.div(60).toFixed(2)
              : null,
          rateAmount: line.rateAmount?.toFixed(4) ?? null,
          amount: money(line.amount),
        })),
      ),
      deductions: row.assignments.flatMap((assignment) =>
        assignment.deductionLines.map((line) => ({
          id: line.id,
          category: line.category,
          description: line.description,
          amount: money(line.amount),
        })),
      ),
      employerContributions: row.assignments.flatMap((assignment) =>
        assignment.contributionLines.map((line) => ({
          id: line.id,
          category: line.category,
          description: line.description,
          amount: money(line.amount),
        })),
      ),
      totals: {
        grossAmount: money(row.grossAmount),
        deductionAmount: money(row.deductionAmount),
        employerContributionAmount: money(row.employerContributionAmount),
        paidHours: paidMinutes.div(60).toFixed(2),
        netAmount: null,
        netStatus: 'STATUTORY_NOT_CALCULATED' as const,
        netPayExplanation: NET_PAY_EXPLANATION,
      },
      yearToDate: {
        currency: run.currency,
        grossAmount: money(ytd._sum.grossAmount ?? new Decimal(0)),
        deductionAmount: money(ytd._sum.deductionAmount ?? new Decimal(0)),
      },
    };
  }

  private async ownEmployeeId(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    const employeeId = user?.person?.employee?.id;
    if (!employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'PAYROLL_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee record.',
        ),
      );
    }
    return employeeId;
  }
}
