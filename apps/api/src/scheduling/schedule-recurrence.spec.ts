import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertAnchorMonday,
  assertRotationWeeks,
  assertWeekIndex,
  dayOfWeekOf,
  durationMinutes,
  findOverlappingRules,
  formatDateOnly,
  formatLocalTime,
  LocalTimeError,
  minuteToTimeColumn,
  occurrenceKey,
  parseLocalTime,
  resolveLocalTime,
  resolveOccurrence,
  rotationWeekOf,
  timeColumnToMinute,
  weekStartOf,
  type RecurrenceInterval,
} from './schedule-recurrence.js';
import {
  ApplyScheduleTemplateDto,
  CreateSchedulePatternDto,
  CreateScheduleTemplateDto,
  RecurrenceRuleDto,
  UpdateRecurrenceRuleDto,
} from './schedule-recurrence.dto.js';

function rule(
  weekIndex: number,
  dayOfWeek: RecurrenceInterval['dayOfWeek'],
  start: string,
  end: string,
): RecurrenceInterval {
  return {
    weekIndex,
    dayOfWeek,
    startMinute: parseLocalTime(start, 'start'),
    endMinute: parseLocalTime(end, 'end'),
  };
}

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe('schedule recurrence', () => {
  it('parses strict HH:mm local times and formats them back', () => {
    expect(parseLocalTime('00:00', 't')).toBe(0);
    expect(parseLocalTime('09:30', 't')).toBe(570);
    expect(parseLocalTime('23:59', 't')).toBe(1439);
    expect(formatLocalTime(570)).toBe('09:30');
    for (const bad of ['24:00', '9:00', '09:60', '09:00:00', '0900', '']) {
      expect(() => parseLocalTime(bad, 't')).toThrow(BadRequestException);
    }
  });

  it('maps local times to TIME columns without any timezone shift', () => {
    const column = minuteToTimeColumn(22 * 60 + 30);
    expect(column.toISOString()).toBe('1970-01-01T22:30:00.000Z');
    expect(timeColumnToMinute(column)).toBe(1350);
  });

  it('treats an end at or before the start as the following local day', () => {
    expect(durationMinutes(rule(0, 'MONDAY', '09:00', '17:00'))).toBe(480);
    expect(durationMinutes(rule(0, 'FRIDAY', '22:00', '06:00'))).toBe(480);
    expect(durationMinutes(rule(0, 'FRIDAY', '08:00', '08:00'))).toBe(1440);
  });

  it('validates rotation length, 0-based week index, and a Monday anchor', () => {
    expect(() => assertRotationWeeks(1)).not.toThrow();
    expect(() => assertRotationWeeks(52)).not.toThrow();
    for (const bad of [0, -1, 53, 1.5]) {
      expect(() => assertRotationWeeks(bad)).toThrow(BadRequestException);
    }
    expect(() => assertWeekIndex(0, 2)).not.toThrow();
    expect(() => assertWeekIndex(1, 2)).not.toThrow();
    expect(() => assertWeekIndex(2, 2)).toThrow(BadRequestException);
    expect(() => assertWeekIndex(-1, 2)).toThrow(BadRequestException);
    expect(() => assertAnchorMonday(date('2026-10-05'))).not.toThrow();
    expect(() => assertAnchorMonday(date('2026-10-06'))).toThrow(
      'anchorDate must be a Monday.',
    );
  });

  it('derives the rotation week from whole weeks after the anchor', () => {
    const anchor = date('2026-10-05');
    expect(rotationWeekOf(anchor, date('2026-10-05'), 2)).toBe(0);
    expect(rotationWeekOf(anchor, date('2026-10-11'), 2)).toBe(0);
    expect(rotationWeekOf(anchor, date('2026-10-12'), 2)).toBe(1);
    expect(rotationWeekOf(anchor, date('2026-10-19'), 2)).toBe(0);
    expect(rotationWeekOf(anchor, date('2026-10-04'), 2)).toBe(1);
    expect(rotationWeekOf(anchor, date('2026-09-28'), 3)).toBe(2);
    // Across a DST change the DATE arithmetic is unaffected.
    expect(rotationWeekOf(anchor, date('2026-11-02'), 2)).toBe(0);
    expect(rotationWeekOf(anchor, date('2026-10-26'), 4)).toBe(3);
  });

  describe('overlap', () => {
    it('allows several separate intervals on one day and touching intervals', () => {
      expect(
        findOverlappingRules(
          [
            rule(0, 'MONDAY', '09:00', '12:00'),
            rule(0, 'MONDAY', '13:00', '17:00'),
            rule(0, 'MONDAY', '17:00', '19:00'),
            rule(0, 'MONDAY', '05:00', '09:00'),
          ],
          1,
        ),
      ).toBeNull();
    });

    it('rejects overlap on the same day, including exact duplicates', () => {
      const a = rule(0, 'MONDAY', '09:00', '13:00');
      const b = rule(0, 'MONDAY', '12:00', '17:00');
      expect(findOverlappingRules([a, b], 1)).toEqual([a, b]);
      expect(findOverlappingRules([a, { ...a }], 1)).not.toBeNull();
    });

    it('rejects an overnight rule running into the next day', () => {
      expect(
        findOverlappingRules(
          [
            rule(0, 'MONDAY', '22:00', '06:00'),
            rule(0, 'TUESDAY', '05:00', '10:00'),
          ],
          1,
        ),
      ).not.toBeNull();
      expect(
        findOverlappingRules(
          [
            rule(0, 'MONDAY', '22:00', '06:00'),
            rule(0, 'TUESDAY', '06:00', '10:00'),
          ],
          1,
        ),
      ).toBeNull();
    });

    it('distinguishes rotation weeks and wraps the last week into week 0', () => {
      expect(
        findOverlappingRules(
          [
            rule(0, 'MONDAY', '09:00', '17:00'),
            rule(1, 'MONDAY', '09:00', '17:00'),
          ],
          2,
        ),
      ).toBeNull();
      expect(
        findOverlappingRules(
          [
            rule(1, 'SUNDAY', '22:00', '06:00'),
            rule(0, 'MONDAY', '05:00', '09:00'),
          ],
          2,
        ),
      ).not.toBeNull();
      // Sunday of week 0 runs into Monday of week 1, not week 0.
      expect(
        findOverlappingRules(
          [
            rule(0, 'SUNDAY', '22:00', '06:00'),
            rule(0, 'MONDAY', '05:00', '09:00'),
          ],
          2,
        ),
      ).toBeNull();
      expect(
        findOverlappingRules(
          [
            rule(0, 'SUNDAY', '22:00', '06:00'),
            rule(0, 'MONDAY', '05:00', '09:00'),
          ],
          1,
        ),
      ).not.toBeNull();
    });
  });
});

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (metatype: new () => object, value: object) =>
  pipe.transform(value, { type: 'body', metatype });

const validRule = {
  weekIndex: 0,
  dayOfWeek: 'MONDAY',
  startLocalTime: '22:00',
  endLocalTime: '06:00',
  timezone: 'America/Toronto',
};

describe('recurrence DTOs', () => {
  it('accepts overnight rules and stable weekday names only', async () => {
    await expect(validate(RecurrenceRuleDto, validRule)).resolves.toMatchObject(
      validRule,
    );
    for (const bad of [
      { dayOfWeek: 1 },
      { dayOfWeek: 'Mon' },
      { startLocalTime: '9:00' },
      { endLocalTime: '24:00' },
      { startLocalTime: '1970-01-01T09:00:00Z' },
      { weekIndex: -1 },
      { weekIndex: 52 },
      { timezone: '' },
      { startsAt: '2026-10-05T09:00:00Z' },
    ]) {
      await expect(
        validate(RecurrenceRuleDto, { ...validRule, ...bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      validate(UpdateRecurrenceRuleDto, { workLocationId: null }),
    ).resolves.toMatchObject({ workLocationId: null });
  });

  it('bounds template rotations and requires rules on manual patterns', async () => {
    const template = {
      organizationId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a001',
      name: 'Two week',
      rotationWeeks: 2,
    };
    await expect(
      validate(CreateScheduleTemplateDto, template),
    ).resolves.toBeDefined();
    for (const rotationWeeks of [0, 53]) {
      await expect(
        validate(CreateScheduleTemplateDto, { ...template, rotationWeeks }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    const pattern = {
      effectiveFrom: '2030-01-07',
      anchorDate: '2030-01-07',
      rotationWeeks: 1,
      rules: [validRule],
    };
    await expect(
      validate(CreateSchedulePatternDto, pattern),
    ).resolves.toBeDefined();
    for (const bad of [
      { rules: [] },
      { effectiveFrom: undefined },
      { anchorDate: undefined },
      { effectiveFrom: '2030-01-07T00:00:00Z' },
      { employmentAssignmentId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a002' },
      { sourceTemplateId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a002' },
    ]) {
      await expect(
        validate(CreateSchedulePatternDto, { ...pattern, ...bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      validate(ApplyScheduleTemplateDto, {
        templateId: '7d4c3b8e-58a4-4e0e-9a39-3f0a9cf9a003',
        effectiveFrom: '2030-01-07',
        anchorDate: '2030-01-07',
        rotationWeeks: 2,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('occurrences', () => {
  const minute = (value: string) => parseLocalTime(value, 't');
  const iso = (value: Date) => value.toISOString();

  it('gives each pattern/rule/local date one stable occurrence key', () => {
    const p = '11111111-1111-4111-8111-111111111111';
    const r = '22222222-2222-4222-8222-222222222222';
    const key = occurrenceKey(p, r, date('2027-03-01'));
    expect(key).toBe(`v1:${p}:${r}:2027-03-01`);
    expect(occurrenceKey(p, r, date('2027-03-01'))).toBe(key);
    expect(occurrenceKey(p, r, date('2027-03-02'))).not.toBe(key);
    expect(occurrenceKey(r, p, date('2027-03-01'))).not.toBe(key);
  });

  it('derives ISO weekdays and week starts from DATE values', () => {
    expect(dayOfWeekOf(date('2027-03-01'))).toBe('MONDAY');
    expect(dayOfWeekOf(date('2027-03-07'))).toBe('SUNDAY');
    expect(formatDateOnly(weekStartOf(date('2027-03-07')))).toBe('2027-03-01');
    expect(formatDateOnly(weekStartOf(date('2027-03-01')))).toBe('2027-03-01');
    expect(formatDateOnly(addDays(date('2027-02-28'), 1))).toBe('2027-03-01');
  });

  describe('America/Toronto daylight-saving transitions', () => {
    const tz = 'America/Toronto';

    it('resolves ordinary times before and after spring-forward', () => {
      expect(
        iso(resolveLocalTime(date('2027-03-13'), minute('09:00'), tz).instant),
      ).toBe('2027-03-13T14:00:00.000Z');
      expect(
        iso(resolveLocalTime(date('2027-03-14'), minute('09:00'), tz).instant),
      ).toBe('2027-03-14T13:00:00.000Z');
      expect(
        iso(resolveLocalTime(date('2027-03-14'), minute('01:59'), tz).instant),
      ).toBe('2027-03-14T06:59:00.000Z');
      expect(
        iso(resolveLocalTime(date('2027-03-14'), minute('03:00'), tz).instant),
      ).toBe('2027-03-14T07:00:00.000Z');
    });

    it('rejects a nonexistent spring-forward time instead of shifting it', () => {
      for (const time of ['02:00', '02:30', '02:59']) {
        expect(() =>
          resolveLocalTime(date('2027-03-14'), minute(time), tz),
        ).toThrow(LocalTimeError);
      }
      expect(() =>
        resolveOccurrence(
          date('2027-03-14'),
          { startMinute: minute('02:30'), endMinute: minute('10:00') },
          tz,
        ),
      ).toThrow(/does not exist/);
      // A nonexistent end fails too.
      expect(() =>
        resolveOccurrence(
          date('2027-03-13'),
          { startMinute: minute('22:00'), endMinute: minute('02:30') },
          tz,
        ),
      ).toThrow(LocalTimeError);
    });

    it('resolves an ambiguous fall-back time to its earlier instant, deterministically', () => {
      const first = resolveLocalTime(date('2027-11-07'), minute('01:30'), tz);
      expect(first).toEqual({
        instant: new Date('2027-11-07T05:30:00.000Z'),
        ambiguous: true,
      });
      expect(resolveLocalTime(date('2027-11-07'), minute('01:30'), tz)).toEqual(
        first,
      );
      expect(resolveLocalTime(date('2027-11-07'), minute('02:00'), tz)).toEqual(
        { instant: new Date('2027-11-07T07:00:00.000Z'), ambiguous: false },
      );
      expect(
        resolveLocalTime(date('2027-11-07'), minute('00:59'), tz).ambiguous,
      ).toBe(false);
    });

    it('keeps the start date as workDate for overnight occurrences across transitions', () => {
      const spring = resolveOccurrence(
        date('2027-03-13'),
        { startMinute: minute('22:00'), endMinute: minute('06:00') },
        tz,
      );
      expect(formatDateOnly(spring.workDate)).toBe('2027-03-13');
      expect(iso(spring.startsAt)).toBe('2027-03-14T03:00:00.000Z');
      expect(iso(spring.endsAt)).toBe('2027-03-14T10:00:00.000Z');
      const fall = resolveOccurrence(
        date('2027-11-06'),
        { startMinute: minute('22:00'), endMinute: minute('06:00') },
        tz,
      );
      expect(iso(fall.startsAt)).toBe('2027-11-07T02:00:00.000Z');
      expect(iso(fall.endsAt)).toBe('2027-11-07T11:00:00.000Z');
      expect(fall.ambiguous).toBe(false);
      // An equal start and end is a full local day.
      const day = resolveOccurrence(
        date('2027-03-01'),
        { startMinute: minute('08:00'), endMinute: minute('08:00') },
        tz,
      );
      expect(iso(day.endsAt)).toBe('2027-03-02T13:00:00.000Z');
    });

    it('does not depend on the runtime timezone', () => {
      const original = process.env.TZ;
      const results: string[] = [];
      try {
        for (const runtime of [
          'UTC',
          'Asia/Kolkata',
          'Pacific/Auckland',
          'America/Los_Angeles',
        ]) {
          process.env.TZ = runtime;
          const occurrence = resolveOccurrence(
            date('2027-11-06'),
            { startMinute: minute('22:00'), endMinute: minute('06:00') },
            tz,
          );
          results.push(`${iso(occurrence.startsAt)}|${iso(occurrence.endsAt)}`);
          expect(dayOfWeekOf(date('2027-03-01'))).toBe('MONDAY');
        }
      } finally {
        process.env.TZ = original;
      }
      expect(new Set(results).size).toBe(1);
    });
  });
});
