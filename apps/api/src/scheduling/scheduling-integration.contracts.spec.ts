import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  LinkScheduledShiftDto,
  ScheduledVsActualQueryDto,
} from '../time/time.dto.js';
import {
  coverageApplicationSteps,
  overlapMinutes,
  type ShiftChangeRequestContract,
} from './scheduling-integration.contracts.js';
import { ScheduledHoursQueryDto } from './scheduling-view.dto.js';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (
  metatype: new () => object,
  value: object,
  type: 'body' | 'query' = 'query',
) => pipe.transform(value, { type, metatype });

const ORG = '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a001';
const SHIFT = '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a002';

describe('coverage contract', () => {
  const request: ShiftChangeRequestContract = {
    type: 'COVERAGE',
    status: 'APPROVED',
    scheduleId: ORG,
    scheduledShiftId: SHIFT,
    basedOnRevisionId: 'revision-1',
    requestedByUserId: 'user-1',
    reason: 'Sick colleague',
    coverage: {
      coveringEmploymentAssignmentId: 'assignment-b',
      startsAt: '2027-03-02T14:00:00.000Z',
      endsAt: '2027-03-02T22:00:00.000Z',
      timezone: 'America/Toronto',
    },
  };

  it('is always cancel-A then add-B, never a reassignment', () => {
    const steps = coverageApplicationSteps(request);
    expect(steps.map((step) => step.action)).toEqual([
      'CANCEL_PUBLISHED_SHIFT',
      'ADD_PUBLISHED_SHIFT',
    ]);
    expect(steps[0]).toMatchObject({
      scheduledShiftId: SHIFT,
      expectedRevisionId: 'revision-1',
      reason: 'Sick colleague',
    });
    expect(steps[1]).toMatchObject({
      employmentAssignmentId: 'assignment-b',
      workLocationId: null,
    });
  });

  it('rejects a CHANGE request or a blank reason', () => {
    expect(() =>
      coverageApplicationSteps({
        ...request,
        type: 'CHANGE',
        coverage: undefined,
      }),
    ).toThrow('Only a COVERAGE request');
    expect(() =>
      coverageApplicationSteps({ ...request, reason: '  ' }),
    ).toThrow('requires a reason');
  });

  it('measures overlap between expected work and an interval', () => {
    const fact = {
      startsAt: '2027-03-02T14:00:00.000Z',
      endsAt: '2027-03-02T22:00:00.000Z',
    };
    expect(
      overlapMinutes(fact, {
        start: '2027-03-02T20:00:00.000Z',
        end: '2027-03-03T00:00:00.000Z',
      }),
    ).toBe(120);
    expect(
      overlapMinutes(fact, {
        start: '2027-03-02T22:00:00.000Z',
        end: '2027-03-03T00:00:00.000Z',
      }),
    ).toBe(0);
  });
});

describe('report and link DTOs', () => {
  it('accepts only whitelisted report dimensions', async () => {
    await expect(
      validate(ScheduledHoursQueryDto, {
        organizationId: ORG,
        from: '2027-03-01',
        to: '2027-03-07',
        groupBy: 'team',
        limit: '50',
      }),
    ).resolves.toMatchObject({ groupBy: 'team', limit: 50 });
    await expect(
      validate(ScheduledHoursQueryDto, {
        organizationId: ORG,
        from: '2027-03-01',
        to: '2027-03-07',
        groupBy: 'p."id"; DROP TABLE "Position"',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(ScheduledHoursQueryDto, {
        organizationId: ORG,
        from: '2027-03-01',
        to: '2027-03-07',
        groupBy: 'team',
        rawSql: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates the scheduled-vs-actual cursor shape', async () => {
    const base = { organizationId: ORG, from: '2027-03-01', to: '2027-03-07' };
    await expect(
      validate(ScheduledVsActualQueryDto, {
        ...base,
        afterKey: `2027-03-02|${SHIFT}`,
      }),
    ).resolves.toBeDefined();
    await expect(
      validate(ScheduledVsActualQueryDto, {
        ...base,
        afterKey: "2027-03-02' OR 1=1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires an explicit shift id or an explicit null to change a link', async () => {
    await expect(
      validate(
        LinkScheduledShiftDto,
        { scheduledShiftId: null, reason: 'Unlink' },
        'body',
      ),
    ).resolves.toMatchObject({ scheduledShiftId: null });
    await expect(
      validate(LinkScheduledShiftDto, { reason: 'Missing' }, 'body'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(
        LinkScheduledShiftDto,
        { scheduledShiftId: SHIFT, reason: '' },
        'body',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
