import { Injectable } from '@nestjs/common';
import { formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Phase 10 — the Core HR facts Payroll needs about the assignments it pays: identity (for the
 * payslip snapshot), position and organization, employment type, and lifecycle dates. Facts
 * only; Payroll snapshots what it used, so later HR edits never change finalized pay.
 */
export const PAYROLL_EMPLOYMENT_SOURCE = Symbol('PAYROLL_EMPLOYMENT_SOURCE');

export interface PayrollEmploymentFact {
  employmentAssignmentId: string;
  employeeId: string;
  employeeNumber: string;
  /** Preferred (or first) name and last name. */
  displayName: string;
  employeeStatus: 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
  /** YYYY-MM-DD. */
  hireDate: string;
  terminationDate: string | null;
  positionId: string;
  positionName: string;
  organizationId: string;
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';
  assignmentStatus: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  startDate: string;
  endDate: string | null;
}

export interface PayrollEmploymentSource {
  employmentFacts(
    employmentAssignmentIds: readonly string[],
    client?: unknown,
  ): Promise<PayrollEmploymentFact[]>;
}

@Injectable()
export class EmployeePayrollSource implements PayrollEmploymentSource {
  constructor(private readonly prisma: PrismaService) {}

  async employmentFacts(
    employmentAssignmentIds: readonly string[],
    client?: unknown,
  ): Promise<PayrollEmploymentFact[]> {
    if (employmentAssignmentIds.length === 0) return [];
    const db = (client as Prisma.TransactionClient | undefined) ?? this.prisma;
    const rows = await db.employmentAssignment.findMany({
      where: { id: { in: [...employmentAssignmentIds] } },
      include: {
        position: { select: { id: true, name: true, organizationId: true } },
        employee: {
          include: {
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => {
      const person = row.employee.person;
      const displayName =
        [person.preferredName ?? person.firstName, person.lastName]
          .filter(Boolean)
          .join(' ') || row.employee.employeeNumber;
      return {
        employmentAssignmentId: row.id,
        employeeId: row.employeeId,
        employeeNumber: row.employee.employeeNumber,
        displayName,
        employeeStatus: row.employee.status,
        hireDate: formatDate(row.employee.hireDate),
        terminationDate: row.employee.terminationDate
          ? formatDate(row.employee.terminationDate)
          : null,
        positionId: row.position.id,
        positionName: row.position.name,
        organizationId: row.position.organizationId,
        employmentType: row.employmentType,
        assignmentStatus: row.status,
        startDate: formatDate(row.startDate),
        endDate: row.endDate ? formatDate(row.endDate) : null,
      };
    });
  }
}
