import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  AddPublishedScheduledShiftDto,
  CancelScheduledShiftDto,
  CorrectScheduledShiftDto,
  CreateScheduledShiftDto,
  CreateScheduleDto,
  ScheduledShiftFieldsDto,
  UpdateScheduledShiftDto,
  UpdateScheduledShiftFieldsDto,
  UpdateScheduleDto,
} from './scheduling.dto.js';

// Mirrors the global pipe configured in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validate = (metatype: new () => object, value: object) =>
  pipe.transform(value, { type: 'body', metatype });

const schedule = {
  scopeType: 'DEPARTMENT',
  organizationId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a001',
  departmentId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a002',
  name: 'Week 41',
  periodStart: '2026-10-05',
  periodEnd: '2026-10-11',
  type: 'STANDARD',
};

const shift = {
  employmentAssignmentId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a003',
  workDate: '2026-10-06',
  startsAt: '2026-10-06T09:00:00-04:00',
  endsAt: '2026-10-06T17:00:00-04:00',
  timezone: 'America/Toronto',
};

describe('scheduling DTOs', () => {
  it('accepts a valid schedule and shift', async () => {
    await expect(validate(CreateScheduleDto, schedule)).resolves.toMatchObject(
      schedule,
    );
    await expect(
      validate(CreateScheduledShiftDto, shift),
    ).resolves.toMatchObject(shift);
  });

  it.each([
    ['status', 'PUBLISHED'],
    ['publishedAt', '2026-10-01T00:00:00Z'],
    ['publishedByUserId', '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a004'],
    ['id', '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a005'],
  ])('rejects client-controlled schedule field %s', async (field, value) => {
    await expect(
      validate(CreateScheduleDto, { ...schedule, [field]: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(UpdateScheduleDto, { [field]: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not allow changing a schedule organization', async () => {
    await expect(
      validate(UpdateScheduleDto, { organizationId: schedule.organizationId }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['sourceType', 'PATTERN'],
    ['status', 'CANCELLED'],
    ['scheduleId', '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a006'],
  ])('rejects client-controlled shift field %s', async (field, value) => {
    await expect(
      validate(CreateScheduledShiftDto, { ...shift, [field]: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(UpdateScheduledShiftDto, { [field]: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects ambiguous dates and timestamps', async () => {
    await expect(
      validate(CreateScheduleDto, {
        ...schedule,
        periodStart: '2026-10-05T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(CreateScheduledShiftDto, {
        ...shift,
        startsAt: '2026-10-06T09:00:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(CreateScheduledShiftDto, {
        ...shift,
        workDate: '2026-10-06T00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown scope and schedule types', async () => {
    await expect(
      validate(CreateScheduleDto, { ...schedule, scopeType: 'PROGRAM' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(CreateScheduleDto, { ...schedule, scopeType: 'SYSTEM' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(CreateScheduleDto, { ...schedule, type: 'RECURRING' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows clearing a shift WorkLocation with null', async () => {
    await expect(
      validate(UpdateScheduledShiftDto, { workLocationId: null }),
    ).resolves.toMatchObject({ workLocationId: null });
  });

  describe('conflict overrides', () => {
    const key = 'a'.repeat(64);
    const override = {
      conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
      conflictKey: key,
      reason: 'Covering a short-staffed shift',
    };

    it('accepts structured overrides on create and update', async () => {
      await expect(
        validate(CreateScheduledShiftDto, {
          ...shift,
          conflictOverrides: [override],
        }),
      ).resolves.toMatchObject({ conflictOverrides: [override] });
      await expect(
        validate(UpdateScheduledShiftDto, { conflictOverrides: [override] }),
      ).resolves.toMatchObject({ conflictOverrides: [override] });
    });

    it.each([
      ['a bare boolean', true],
      ['a non-array object', override],
      ['a missing reason', [{ ...override, reason: undefined }]],
      ['an empty reason', [{ ...override, reason: '' }]],
      ['an unknown conflict type', [{ ...override, conflictType: 'MIN_REST' }]],
      ['a malformed key', [{ ...override, conflictKey: 'not-a-key' }]],
      ['an uppercase key', [{ ...override, conflictKey: 'A'.repeat(64) }]],
      ['extra properties', [{ ...override, severity: 'INFO' }]],
      [
        'a reason over 1000 characters',
        [{ ...override, reason: 'x'.repeat(1001) }],
      ],
    ])('rejects %s', async (_label, conflictOverrides) => {
      await expect(
        validate(CreateScheduledShiftDto, { ...shift, conflictOverrides }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects override flags that are not structured overrides', async () => {
      await expect(
        validate(CreateScheduledShiftDto, { ...shift, override: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not accept overrides on read-only conflict previews', async () => {
      await expect(
        validate(ScheduledShiftFieldsDto, {
          ...shift,
          conflictOverrides: [override],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        validate(UpdateScheduledShiftFieldsDto, {
          conflictOverrides: [override],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('published-change DTOs', () => {
  it('requires a non-empty reason for corrections, additions, and cancellations', async () => {
    for (const [metatype, body] of [
      [CorrectScheduledShiftDto, { endsAt: '2026-10-06T18:00:00-04:00' }],
      [AddPublishedScheduledShiftDto, shift],
      [CancelScheduledShiftDto, {}],
    ] as const) {
      await expect(validate(metatype, body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        validate(metatype, { ...body, reason: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        validate(metatype, { ...body, reason: 'x'.repeat(1001) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        validate(metatype, { ...body, reason: 'Approved change' }),
      ).resolves.toMatchObject({ reason: 'Approved change' });
    }
  });

  it.each([
    ['status', 'CANCELLED'],
    ['sourceType', 'PATTERN'],
    ['revisionNumber', 2],
    ['revisionType', 'CORRECTED'],
  ])('rejects server-controlled field %s', async (field, value) => {
    await expect(
      validate(CorrectScheduledShiftDto, { reason: 'Fix', [field]: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(AddPublishedScheduledShiftDto, {
        ...shift,
        reason: 'Add',
        [field]: value,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(CancelScheduledShiftDto, { reason: 'Cancel', [field]: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
