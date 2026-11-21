import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  CorrectAssignmentDto,
  CreateAssignmentDto,
  CreateEmployeeDto,
  EmployeeDirectoryQueryDto,
  EndAssignmentDto,
  InactivateEmployeeDto,
  RehireEmployeeDto,
  RevokeEmployeeGrantsDto,
  TerminateEmployeeDto,
} from './employee.dto.js';

// Mirrors the global pipe configured in http-application.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const directoryQuery = (value: object) =>
  pipe.transform(value, {
    type: 'query',
    metatype: EmployeeDirectoryQueryDto,
  }) as Promise<EmployeeDirectoryQueryDto>;

describe('Employee lifecycle DTOs', () => {
  const assignment = {
    positionId: '11111111-1111-4111-8111-111111111111',
    employmentType: 'FULL_TIME',
    startDate: '2027-01-15',
  };
  const errors = (type: any, value: object) =>
    validateSync(plainToInstance(type, value) as object).length;

  it('requires literal YYYY-MM-DD termination and rehire dates', () => {
    expect(
      errors(TerminateEmployeeDto, { terminationDate: '2026-12-31' }),
    ).toBe(0);
    expect(errors(RehireEmployeeDto, { assignment })).toBe(0);
    expect(
      errors(TerminateEmployeeDto, {
        terminationDate: '2026-12-31T00:00:00.000Z',
      }),
    ).toBeGreaterThan(0);
    expect(
      errors(RehireEmployeeDto, {
        assignment: { ...assignment, startDate: '2027-01-15T00:00:00.000Z' },
      }),
    ).toBeGreaterThan(0);
    expect(errors(TerminateEmployeeDto, {})).toBeGreaterThan(0);
  });

  it('Batch 5A: a rehire always carries the new assignment', () => {
    expect(errors(RehireEmployeeDto, {})).toBeGreaterThan(0);
    expect(
      errors(RehireEmployeeDto, { hireDate: '2027-01-15' }),
    ).toBeGreaterThan(0);
    expect(
      errors(RehireEmployeeDto, {
        assignment: { ...assignment, positionId: 'x' },
      }),
    ).toBeGreaterThan(0);
  });

  it('Batch 5A: assignment and employee dates are strict YYYY-MM-DD', () => {
    const base = {
      positionId: assignment.positionId,
      employmentType: 'FULL_TIME',
    };
    expect(
      errors(CreateAssignmentDto, { ...base, startDate: '2027-01-15' }),
    ).toBe(0);
    for (const startDate of [
      '2027-1-15',
      '2027-01-15T00:00:00Z',
      '20270115',
      'tomorrow',
    ])
      expect(
        errors(CreateAssignmentDto, { ...base, startDate }),
      ).toBeGreaterThan(0);
    expect(
      errors(EndAssignmentDto, { endDate: '2027-01-15T00:00' }),
    ).toBeGreaterThan(0);
    expect(
      errors(CorrectAssignmentDto, {
        employmentType: 'FULL_TIME',
        startDate: '2027-01-15',
        endDate: '2027/01/20',
      }),
    ).toBeGreaterThan(0);
    expect(
      errors(CreateEmployeeDto, { hireDate: '2027-01-15T10:00:00Z' }),
    ).toBeGreaterThan(0);
  });

  it('Batch 5A: a nested new person is validated', () => {
    expect(
      errors(CreateEmployeeDto, {
        hireDate: '2027-01-15',
        person: { firstName: 'Ana', personalEmail: 'not-an-email' },
      }),
    ).toBeGreaterThan(0);
    expect(
      errors(CreateEmployeeDto, {
        hireDate: '2027-01-15',
        person: { firstName: 'Ana', personalEmail: 'ana@example.test' },
      }),
    ).toBe(0);
  });

  it('Batch 5A: inactivation needs a reason; grant revocation needs ids', () => {
    expect(errors(InactivateEmployeeDto, {})).toBeGreaterThan(0);
    expect(errors(InactivateEmployeeDto, { reason: 'Leave of absence' })).toBe(
      0,
    );
    expect(
      errors(RevokeEmployeeGrantsDto, { roleAssignmentIds: [] }),
    ).toBeGreaterThan(0);
    expect(
      errors(RevokeEmployeeGrantsDto, {
        roleAssignmentIds: [assignment.positionId],
      }),
    ).toBe(0);
  });
});

describe('EmployeeDirectoryQueryDto limit', () => {
  it('accepts a query without a limit', async () => {
    await expect(directoryQuery({})).resolves.toEqual({});
  });

  it('converts query-string limits to integers (the web directory sends limit=25)', async () => {
    await expect(directoryQuery({ limit: '25' })).resolves.toMatchObject({
      limit: 25,
    });
    await expect(directoryQuery({ limit: '1' })).resolves.toMatchObject({
      limit: 1,
    });
    await expect(directoryQuery({ limit: '100' })).resolves.toMatchObject({
      limit: 100,
    });
  });

  it.each(['0', '-1', '101', '2.5', 'abc', ''])(
    'rejects limit=%j',
    async (limit) => {
      await expect(directoryQuery({ limit })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});
