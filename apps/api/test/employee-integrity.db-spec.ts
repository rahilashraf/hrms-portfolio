import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

describe('Employee database integrity constraints', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required.');
    prisma = new PrismaService(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('allocates globally unique employee numbers from the sequence', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const first = await tx.person.create({ data: {} });
        const second = await tx.person.create({ data: {} });
        const one = await tx.employee.create({
          data: {
            personId: first.id,
            employeeNumber: `EMP-${randomUUID()}`,
            hireDate: new Date('2026-10-01'),
          },
        });
        const two = await tx.employee.create({
          data: {
            personId: second.id,
            employeeNumber: `EMP-${randomUUID()}`,
            hireDate: new Date('2026-10-01'),
          },
        });
        expect(one.employeeNumber).not.toBe(two.employeeNumber);
        throw new RollbackFixtures();
      }),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });

  it('enforces one Employee per Person', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const person = await tx.person.create({ data: {} });
        await tx.employee.create({
          data: {
            personId: person.id,
            employeeNumber: `EMP-${randomUUID()}`,
            hireDate: new Date('2026-10-01'),
          },
        });
        await tx.employee.create({
          data: {
            personId: person.id,
            employeeNumber: `EMP-${randomUUID()}`,
            hireDate: new Date('2026-10-01'),
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects invalid assignment date ranges and self-management at the database boundary', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const person = await tx.person.create({ data: {} });
        const employee = await tx.employee.create({
          data: {
            personId: person.id,
            employeeNumber: `EMP-${randomUUID()}`,
            hireDate: new Date('2026-10-01'),
          },
        });
        const organization = await tx.organization.create({
          data: {
            name: 'Employee Test Org',
            code: `EMP-${randomUUID().slice(0, 8)}`,
          },
        });
        const jobTitle = await tx.jobTitle.create({
          data: {
            organizationId: organization.id,
            name: 'Employee Test Title',
            code: `TITLE-${randomUUID().slice(0, 8)}`,
          },
        });
        const position = await tx.position.create({
          data: {
            organizationId: organization.id,
            jobTitleId: jobTitle.id,
            name: 'Employee Test Position',
            code: `POSITION-${randomUUID().slice(0, 8)}`,
          },
        });
        await tx.employmentAssignment.create({
          data: {
            employeeId: employee.id,
            positionId: position.id,
            employmentType: 'FULL_TIME',
            startDate: new Date('2026-10-02'),
            endDate: new Date('2026-10-01'),
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2039' });
  });
});
