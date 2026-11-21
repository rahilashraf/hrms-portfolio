import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  ChangeCompensationDto,
  CorrectCompensationDto,
  CreateCompensationDto,
  EndCompensationDto,
  PayGroupListQueryDto,
} from './compensation.dto.js';

const errors = <T extends object>(type: new () => T, value: object) =>
  validateSync(plainToInstance(type, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

const valid = {
  payBasis: 'HOURLY',
  rateAmount: '24.50',
  currency: 'CAD',
  effectiveFrom: '2026-01-01',
};

describe('Compensation DTOs', () => {
  it('accepts money only as a decimal string, never a JSON number', () => {
    expect(errors(CreateCompensationDto, valid)).toEqual([]);
    expect(
      errors(CreateCompensationDto, { ...valid, rateAmount: 24.5 }),
    ).toEqual(['rateAmount']);
    expect(
      errors(ChangeCompensationDto, { ...valid, rateAmount: 24.5 }),
    ).toEqual(['rateAmount']);
    expect(
      errors(CorrectCompensationDto, { rateAmount: 24.5, reason: 'x' }),
    ).toEqual(['rateAmount']);
  });

  it('knows only the two pay bases, three-letter currencies and literal dates', () => {
    expect(
      errors(CreateCompensationDto, { ...valid, payBasis: 'MONTHLY' }),
    ).toEqual(['payBasis']);
    expect(errors(CreateCompensationDto, { ...valid, currency: 'CA' })).toEqual(
      ['currency'],
    );
    expect(
      errors(CreateCompensationDto, {
        ...valid,
        effectiveFrom: '2026-01-01T00:00:00Z',
      }),
    ).toEqual(['effectiveFrom']);
    expect(
      errors(CreateCompensationDto, { ...valid, payGroupId: null }),
    ).toEqual([]);
    expect(
      errors(CreateCompensationDto, { ...valid, payGroupId: 'not-a-uuid' }),
    ).toEqual(['payGroupId']);
  });

  it('accepts salary arrangement fields with decimal strings and date-only periods', () => {
    expect(
      errors(CreateCompensationDto, {
        ...valid,
        payBasis: 'SALARY',
        rateAmount: '4000',
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4000',
        salaryPaidMonths: 10,
        salaryContractAmount: '40000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
        effectiveTo: '2027-06-30',
      }),
    ).toEqual([]);
    expect(
      errors(CreateCompensationDto, {
        ...valid,
        salaryArrangement: 'MONTHLY',
      }),
    ).toEqual(['salaryArrangement']);
    expect(
      errors(CreateCompensationDto, {
        ...valid,
        salaryArrangement: 'CONTRACT_TOTAL',
        salaryContractAmount: 1000,
      }),
    ).toEqual(['salaryContractAmount']);
  });

  it('has no mutable fields beyond the domain ones', () => {
    expect(
      errors(CreateCompensationDto, { ...valid, recordType: 'CORRECTION' }),
    ).toEqual(['recordType']);
    expect(
      errors(ChangeCompensationDto, { ...valid, effectiveTo: '2026-12-31' }),
    ).toEqual(['effectiveTo']);
    expect(
      errors(CorrectCompensationDto, { supersededAt: 'now', reason: 'x' }),
    ).toEqual(['supersededAt']);
  });

  it('requires a reason for a correction and a date to end a period', () => {
    expect(errors(CorrectCompensationDto, { rateAmount: '25' })).toEqual([
      'reason',
    ]);
    expect(
      errors(CorrectCompensationDto, {
        effectiveTo: null,
        reason: 'Ongoing after all',
      }),
    ).toEqual([]);
    expect(errors(EndCompensationDto, {})).toEqual(['effectiveTo']);
    expect(errors(EndCompensationDto, { effectiveTo: '2026-12-31' })).toEqual(
      [],
    );
  });

  it('parses the include-archived flag of the pay-group list', () => {
    const query = plainToInstance(PayGroupListQueryDto, {
      organizationId: '1a8c5f0e-1d4b-4b8e-9c1e-0d6a2f3b4c5d',
      includeArchived: 'true',
    });
    expect(validateSync(query)).toHaveLength(0);
    expect(query.includeArchived).toBe(true);
  });
});
