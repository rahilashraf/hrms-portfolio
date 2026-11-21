import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG,
  TimeDomainService,
} from './time-domain.service.js';

describe('TimeDomainService', () => {
  const service = new TimeDomainService();

  it('derives strict local work dates from an instant and IANA timezone', () => {
    expect(
      service.deriveWorkDate(
        new Date('2026-10-03T02:00:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('2026-10-02');
    expect(
      service.deriveWorkDate(
        new Date('2026-10-03T02:00:00.000Z'),
        'Europe/London',
      ),
    ).toBe('2026-10-03');
  });

  it('handles DST-sensitive local date boundaries through Intl timezone data', () => {
    expect(
      service.deriveWorkDate(
        new Date('2026-03-08T06:30:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('2026-03-08');
    expect(
      service.deriveWorkDate(
        new Date('2026-11-01T05:30:00.000Z'),
        'America/Toronto',
      ),
    ).toBe('2026-11-01');
  });

  it('rejects blank, non-IANA, and invalid instants', () => {
    expect(() => service.assertIanaTimezone('America/Toronto')).not.toThrow();
    expect(() => service.assertIanaTimezone('+05:30')).toThrow(
      BadRequestException,
    );
    expect(() => service.assertIanaTimezone('')).toThrow(BadRequestException);
    expect(() =>
      service.deriveWorkDate(new Date(Number.NaN), 'America/Toronto'),
    ).toThrow(BadRequestException);
  });

  it('parses date-only values strictly without accepting malformed dates', () => {
    expect(service.parseDateOnly('2026-10-02').toISOString()).toBe(
      '2026-10-02T00:00:00.000Z',
    );
    expect(() => service.parseDateOnly('2026-10-02T00:00:00Z')).toThrow(
      BadRequestException,
    );
    expect(() => service.parseDateOnly('2026-02-30')).toThrow(
      BadRequestException,
    );
  });

  it('parses local datetimes with the supplied authoritative timezone', () => {
    expect(
      service
        .parseLocalDateTime('2026-10-02T22:00', 'America/Toronto')
        .toISOString(),
    ).toBe('2026-10-03T02:00:00.000Z');
    expect(
      service.parseLocalDateTime('2026-10-02T22:00:30', 'UTC').toISOString(),
    ).toBe('2026-10-02T22:00:30.000Z');
  });

  it('rejects malformed and nonexistent local datetimes', () => {
    expect(() =>
      service.parseLocalDateTime('2026-10-02T22:00Z', 'America/Toronto'),
    ).toThrow(BadRequestException);
    expect(() =>
      service.parseLocalDateTime('2026-03-08T02:30', 'America/Toronto'),
    ).toThrow(BadRequestException);
  });

  it('refuses ambiguous fall-back local datetimes with both occurrences, and accepts an explicit offset (Batch 4D, D-C)', () => {
    let error: unknown;
    try {
      service.parseLocalDateTime('2026-11-01T01:30', 'America/Toronto');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'TIME_LOCAL_TIME_AMBIGUOUS',
      occurrences: [
        {
          instant: '2026-11-01T05:30:00.000Z',
          offset: '-04:00',
          value: '2026-11-01T01:30-04:00',
        },
        {
          instant: '2026-11-01T06:30:00.000Z',
          offset: '-05:00',
          value: '2026-11-01T01:30-05:00',
        },
      ],
    });
    // Each occurrence by its offset; an offset the zone never has there is refused.
    expect(
      service
        .parseLocalDateTime('2026-11-01T01:30-04:00', 'America/Toronto')
        .toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
    expect(
      service
        .parseLocalDateTime('2026-11-01T01:30-05:00', 'America/Toronto')
        .toISOString(),
    ).toBe('2026-11-01T06:30:00.000Z');
    expect(
      service
        .parseLocalDateTime('2026-07-01T09:00-04:00', 'America/Toronto')
        .toISOString(),
    ).toBe('2026-07-01T13:00:00.000Z');
    for (const value of [
      '2026-11-01T01:30+05:30',
      '2026-07-01T09:00-05:00',
      '2026-03-08T02:30-05:00',
    ]) {
      expect(() =>
        service.parseLocalDateTime(value, 'America/Toronto'),
      ).toThrow(BadRequestException);
    }
    // Adelaide (+10:30 / +09:30): the 2026-04-05 fall-back overlap.
    expect(() =>
      service.parseLocalDateTime('2026-04-05T02:30', 'Australia/Adelaide'),
    ).toThrow(ConflictException);
    expect(
      service
        .parseLocalDateTime('2026-04-05T02:30+09:30', 'Australia/Adelaide')
        .toISOString(),
    ).toBe('2026-04-04T17:00:00.000Z');
  });

  it('resolves policy times deterministically across daylight saving: gaps forward, overlaps earlier (Batch 4D, D-B)', () => {
    const at = (date: string, time: string, zone: string) =>
      service.resolvePolicyLocalDateTime(date, time, zone).toISOString();
    // Toronto spring-forward (02:00 → 03:00): 02:30 is 03:30 EDT.
    expect(at('2027-03-14', '02:30', 'America/Toronto')).toBe(
      '2027-03-14T07:30:00.000Z',
    );
    // Toronto fall-back: 01:30 is its first (EDT) occurrence.
    expect(at('2027-11-07', '01:30', 'America/Toronto')).toBe(
      '2027-11-07T05:30:00.000Z',
    );
    // Adelaide spring-forward (2026-10-04 02:00 → 03:00, +09:30 → +10:30): 02:15 is 03:15.
    expect(at('2026-10-04', '02:15', 'Australia/Adelaide')).toBe(
      '2026-10-03T16:45:00.000Z',
    );
    // Adelaide fall-back (2026-04-05 03:00 → 02:00): 02:30 is its first (+10:30) occurrence.
    expect(at('2026-04-05', '02:30', 'Australia/Adelaide')).toBe(
      '2026-04-04T16:00:00.000Z',
    );
    // Aliases resolve like their current names; an ordinary day is unchanged.
    expect(at('2026-11-01', '09:00', 'Asia/Kolkata')).toBe(
      at('2026-11-01', '09:00', 'Asia/Calcutta'),
    );
    expect(at('2027-03-15', '09:00', 'America/Toronto')).toBe(
      '2027-03-15T13:00:00.000Z',
    );
  });

  it('keeps seconds, fractional offsets and the gap and overlap errors', () => {
    expect(
      service
        .parseLocalDateTime('2026-01-15T09:00:15', 'Asia/Kabul')
        .toISOString(),
    ).toBe('2026-01-15T04:30:15.000Z');
    expect(() =>
      service.parseLocalDateTime('2026-03-08T02:00', 'America/Toronto'),
    ).toThrow('does not exist');
    expect(() =>
      service.parseLocalDateTime('2026-11-01T01:00', 'America/Toronto'),
    ).toThrow('occurs twice');
    expect(
      service
        .parseLocalDateTime('2026-11-01T02:00', 'America/Toronto')
        .toISOString(),
    ).toBe('2026-11-01T07:00:00.000Z');
  });

  it('parses local datetimes with a bounded number of time zone lookups', () => {
    // Phase 6 searched every minute of a 28-hour window: one formatter construction and one
    // formatToParts call per minute, about 1,680 per parse. The offset-based search needs a
    // handful. Counting lookups catches that regression on any machine, unlike a tight timer.
    const lookups = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const readings: Array<[string, string]> = [
      ['2026-03-08T02:30', 'America/Toronto'], // spring-forward gap
      ['2026-11-01T01:30', 'America/Toronto'], // fall-back overlap
      ['2026-10-04T02:15', 'Australia/Lord_Howe'], // 30-minute daylight saving gap
      ['2026-04-05T01:45', 'Australia/Lord_Howe'], // 30-minute overlap
      ['2026-06-15T12:00', 'Asia/Kabul'], // half-hour offset
    ];
    for (let index = 0; index < 200; index++) {
      readings.push([
        `2026-${String((index % 12) + 1).padStart(2, '0')}-15T09:${String(index % 60).padStart(2, '0')}`,
        index % 2 === 0 ? 'America/Toronto' : 'Asia/Kabul',
      ]);
    }
    try {
      let most = 0;
      const started = performance.now();
      for (const [value, timezone] of readings) {
        lookups.mockClear();
        try {
          expect(
            Number.isNaN(service.parseLocalDateTime(value, timezone).getTime()),
          ).toBe(false);
        } catch (error) {
          // Gap and overlap readings are refused (asserted elsewhere); their lookups count too.
          expect(
            error instanceof BadRequestException ||
              error instanceof ConflictException,
          ).toBe(true);
        }
        most = Math.max(most, lookups.mock.calls.length);
      }
      expect(most).toBeGreaterThan(0);
      expect(most).toBeLessThanOrEqual(10);
      // A coarse backstop for slow paths the count cannot see. Shared CI runners take about
      // 1 ms per parse, so this has ample headroom; the old search took over 100 s here.
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      lookups.mockRestore();
    }
  });

  it('treats policy effective dates as inclusive date-only ranges', () => {
    const range = { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' };
    expect(service.isEffectiveOn(range, '2026-10-01')).toBe(true);
    expect(service.isEffectiveOn(range, '2026-10-31')).toBe(true);
    expect(service.isEffectiveOn(range, '2026-11-01')).toBe(false);
    expect(() =>
      service.assertEffectiveDateRange({
        effectiveFrom: '2026-10-02',
        effectiveTo: '2026-10-01',
      }),
    ).toThrow(BadRequestException);
  });

  it('resolves composable policy sections with inherit and override layers', () => {
    const resolved = service.resolvePolicyConfig([
      {
        inheritanceMode: 'INHERIT',
        config: {
          clock: { mode: 'LIVE_CLOCK', requiresLocation: true },
          correction: { mode: 'REVIEW_REQUIRED' },
        },
      },
      {
        inheritanceMode: 'INHERIT',
        config: {
          clock: { assignmentSwitching: true, requiresLocation: false },
          breaks: { mode: 'MANUAL_PUNCH' },
        },
      },
    ]);

    expect(resolved.clock).toEqual({
      mode: 'LIVE_CLOCK',
      assignmentSwitching: true,
      requiresLocation: false,
    });
    expect(resolved.breaks).toEqual({ mode: 'MANUAL_PUNCH' });
    expect(resolved.correction).toEqual({ mode: 'REVIEW_REQUIRED' });
    expect(resolved.timesheet).toEqual(
      DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG.timesheet,
    );

    const overridden = service.resolvePolicyConfig([
      {
        inheritanceMode: 'INHERIT',
        config: { clock: { mode: 'LIVE_CLOCK', requiresLocation: true } },
      },
      {
        inheritanceMode: 'OVERRIDE',
        config: { breaks: { mode: 'MANUAL_PUNCH' } },
      },
    ]);

    expect(overridden.clock).toEqual(
      DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG.clock,
    );
    expect(overridden.breaks).toEqual({ mode: 'MANUAL_PUNCH' });
  });

  it('resolves mixed hierarchy sections without leaking unrelated overrides', () => {
    const resolved = service.resolvePolicyConfig([
      {
        inheritanceMode: 'INHERIT',
        config: {
          clock: { mode: 'LIVE_CLOCK' },
          breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
        },
      },
      {
        inheritanceMode: 'INHERIT',
        config: {
          breaks: { mode: 'MANUAL_PUNCH', defaultPayType: 'UNPAID' },
        },
      },
      {
        inheritanceMode: 'INHERIT',
        config: {
          clock: { mode: 'DISABLED' },
        },
      },
    ]);

    expect(resolved.clock).toEqual({ mode: 'DISABLED' });
    expect(resolved.breaks).toEqual({
      mode: 'MANUAL_PUNCH',
      autoDeductMinutes: 30,
      defaultPayType: 'UNPAID',
    });
  });

  it('defaults breaks to NONE and preserves manual-punch break config', () => {
    const resolved = service.resolvePolicyConfig([
      {
        inheritanceMode: 'INHERIT',
        config: {
          breaks: {
            mode: 'MANUAL_PUNCH',
            paidUnpaidClassification: true,
            defaultPayType: 'UNPAID',
          },
        },
      },
    ]);

    expect(DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG.breaks).toEqual({
      mode: 'NONE',
    });
    expect(resolved.breaks).toEqual({
      mode: 'MANUAL_PUNCH',
      paidUnpaidClassification: true,
      defaultPayType: 'UNPAID',
    });
  });

  it('rejects malformed policy config layers', () => {
    expect(() =>
      service.resolvePolicyConfig([{ inheritanceMode: 'INHERIT', config: [] }]),
    ).toThrow(BadRequestException);
    expect(() =>
      service.resolvePolicyConfig([
        { inheritanceMode: 'INHERIT', config: { clock: true } },
      ]),
    ).toThrow(BadRequestException);
  });

  it('reports where each resolved setting comes from: a layer, the default, or an override reset (Batch 4E-2, B1)', () => {
    const layers = [
      {
        inheritanceMode: 'INHERIT' as const,
        config: {
          clock: { mode: 'LIVE_CLOCK' },
          breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
        },
      },
      {
        inheritanceMode: 'INHERIT' as const,
        config: { breaks: { autoDeductMinutes: 45 } },
      },
    ];
    const inherited = service.resolvePolicyWithSources(layers);
    expect(inherited.config).toEqual(service.resolvePolicyConfig(layers));
    expect(inherited.config.breaks.autoDeductMinutes).toBe(45);
    expect(inherited.sources.clock?.mode).toEqual({
      kind: 'LAYER',
      layerIndex: 0,
    });
    expect(inherited.sources.breaks?.mode).toEqual({
      kind: 'LAYER',
      layerIndex: 0,
    });
    expect(inherited.sources.breaks?.autoDeductMinutes).toEqual({
      kind: 'LAYER',
      layerIndex: 1,
    });
    expect(inherited.sources.correction?.mode).toEqual({
      kind: 'DEFAULT',
    });

    const overridden = service.resolvePolicyWithSources([
      ...layers,
      { inheritanceMode: 'OVERRIDE', config: { breaks: { mode: 'NONE' } } },
    ]);
    expect(overridden.config.clock.mode).toBe(
      DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG.clock.mode,
    );
    expect(overridden.sources.clock?.mode).toEqual({
      kind: 'DEFAULT',
      resetByLayerIndex: 2,
    });
    expect(overridden.sources.breaks?.mode).toEqual({
      kind: 'LAYER',
      layerIndex: 2,
    });
  });
});
