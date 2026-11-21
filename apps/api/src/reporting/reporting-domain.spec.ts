import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  csvField,
  describeFilters,
  exportFileName,
  MAX_RANGE_DAYS,
  median,
  MIN_GROUP_SIZE,
  monthsInRange,
  neutralizeFormula,
  parseReportFilters,
  percent,
  suppressSmallGroups,
  toCsv,
  turnoverRate,
  type FilterSpec,
} from './reporting-domain.js';
import {
  REPORT_DEFINITIONS,
  requiredPermissions,
} from './reporting-registry.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const today = d('2026-10-06');
const UUID = '00000000-0000-4000-8000-000000000001';

function code(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { code: string })
      .code;
  }
  throw new Error('Expected a validation error.');
}

const range: FilterSpec = {
  dateMode: 'RANGE',
  filters: ['from', 'to', 'departmentId', 'employmentType', 'groupBy'],
  groupBy: ['month', 'department'],
};

describe('reporting domain — filters', () => {
  it('defaults a range to the twelve months ending today', () => {
    const filters = parseReportFilters(range, {}, today);
    expect(filters.to).toEqual(today);
    expect(filters.from).toEqual(d('2025-10-07'));
    expect(filters.groupBy).toBe('month');
    expect(filters.asOf).toBeNull();
  });

  it('defaults an as-of report to today and ignores ranges', () => {
    const filters = parseReportFilters(
      { dateMode: 'AS_OF', filters: ['asOf'] },
      {},
      today,
    );
    expect(filters.asOf).toEqual(today);
    expect(filters.from).toBeNull();
  });

  it('refuses filters a report does not support', () => {
    expect(code(() => parseReportFilters(range, { teamId: UUID }, today))).toBe(
      'REPORT_FILTER_UNSUPPORTED',
    );
    expect(
      code(() =>
        parseReportFilters(
          { dateMode: 'NONE', filters: [] },
          { from: '2026-01-01' },
          today,
        ),
      ),
    ).toBe('REPORT_FILTER_UNSUPPORTED');
  });

  it('validates dates, ranges, identifiers and enumerations strictly', () => {
    expect(
      code(() => parseReportFilters(range, { from: '2026-02-30' }, today)),
    ).toBe('REPORT_FILTER_INVALID');
    expect(
      code(() => parseReportFilters(range, { to: '06/10/2026' }, today)),
    ).toBe('REPORT_FILTER_INVALID');
    expect(
      code(() =>
        parseReportFilters(
          range,
          { from: '2026-05-01', to: '2026-04-30' },
          today,
        ),
      ),
    ).toBe('REPORT_RANGE_INVALID');
    expect(
      code(() =>
        parseReportFilters(
          range,
          { from: '2020-01-01', to: '2026-01-01' },
          today,
        ),
      ),
    ).toBe('REPORT_RANGE_TOO_LONG');
    expect(
      code(() => parseReportFilters(range, { departmentId: 'x' }, today)),
    ).toBe('REPORT_FILTER_INVALID');
    expect(
      code(() =>
        parseReportFilters(range, { employmentType: 'INTERN' }, today),
      ),
    ).toBe('REPORT_FILTER_INVALID');
    expect(
      code(() => parseReportFilters(range, { groupBy: 'team' }, today)),
    ).toBe('REPORT_FILTER_INVALID');
    // Exactly the maximum span is accepted.
    const from = d('2021-10-01');
    const to = new Date(from.getTime() + (MAX_RANGE_DAYS - 1) * 86_400_000);
    expect(
      parseReportFilters(
        range,
        {
          from: '2021-10-01',
          to: to.toISOString().slice(0, 10),
        },
        to,
      ).from,
    ).toEqual(from);
  });

  it('describes filters with identifiers and dates only', () => {
    const filters = parseReportFilters(
      range,
      {
        from: '2026-01-01',
        to: '2026-03-31',
        departmentId: UUID.toUpperCase(),
      },
      today,
    );
    expect(describeFilters(filters)).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
      departmentId: UUID,
      groupBy: 'month',
    });
  });
});

describe('reporting domain — dates and ratios', () => {
  it('splits a range into clipped calendar months', () => {
    expect(
      monthsInRange(d('2026-01-15'), d('2026-03-10')).map((m) => [
        m.key,
        m.start.toISOString().slice(0, 10),
        m.end.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      ['2026-01', '2026-01-15', '2026-01-31'],
      ['2026-02', '2026-02-01', '2026-02-28'],
      ['2026-03', '2026-03-01', '2026-03-10'],
    ]);
    expect(monthsInRange(d('2024-02-01'), d('2024-02-29'))).toHaveLength(1);
    expect(monthsInRange(d('2025-12-31'), d('2026-01-01'))).toHaveLength(2);
  });

  it('computes percentages, medians, turnover and buckets', () => {
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(1, 0)).toBeNull();
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(turnoverRate(2, 10, 30)).toBe(10);
    expect(turnoverRate(0, 0, 0)).toBeNull();
    expect(bucketOf(23.5, 5)).toEqual({ from: 20, to: 25 });
    expect(bucketOf(65_000, 10_000)).toEqual({ from: 60_000, to: 70_000 });
  });
});

describe('reporting domain — small-group suppression', () => {
  const rows = [
    { group: 'A', currency: 'CAD', employees: 12, average: 30 },
    { group: 'B', currency: 'CAD', employees: 4, average: 55 },
    { group: 'C', currency: 'CAD', employees: 6, average: 40 },
    { group: 'D', currency: 'CAD', employees: 9, average: 35 },
  ];

  it('masks groups under the minimum and flags them', () => {
    expect(MIN_GROUP_SIZE).toBe(5);
    const result = suppressSmallGroups(rows, 'employees', ['group']);
    expect(result.suppressed).toBe(1);
    expect(result.rows[1]).toEqual({
      group: 'B',
      currency: null,
      employees: null,
      average: null,
      suppressed: true,
    });
    expect(result.rows[0]).toMatchObject({ employees: 12, suppressed: false });
  });

  it('suppresses a complementary group when a single one would be derivable', () => {
    const result = suppressSmallGroups(
      rows,
      'employees',
      ['group', 'currency'],
      {
        partition: ['currency'],
      },
    );
    expect(result.suppressed).toBe(2);
    // The next smallest group (C, 6) goes too; A and D stay.
    expect(result.rows.map((r) => r.suppressed)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // Two suppressed groups already: nothing more is hidden.
    const two = suppressSmallGroups(
      [...rows, { group: 'E', currency: 'CAD', employees: 1, average: 99 }],
      'employees',
      ['group'],
      { partition: ['currency'] },
    );
    expect(two.suppressed).toBe(2);
    // A lone small group has no complement to hide.
    expect(
      suppressSmallGroups([rows[1]!], 'employees', ['group'], {
        partition: ['currency'],
      }).suppressed,
    ).toBe(1);
  });
});

describe('reporting domain — CSV', () => {
  it('neutralizes formula injection', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])
      expect(neutralizeFormula(value)).toBe(`'${value}`);
    expect(neutralizeFormula('Dept A')).toBe('Dept A');
    expect(csvField(-5)).toBe('-5');
    expect(csvField('-5')).toBe("'-5");
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('true');
  });

  it('quotes fields per RFC 4180 with CRLF rows', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(
      toCsv(
        [
          { key: 'group', label: 'Group, name' },
          { key: 'count', label: 'Count' },
        ],
        [
          { group: '=cmd|calc', count: 3 },
          { group: 'Plain', count: null },
        ],
      ),
    ).toBe(`"Group, name",Count\r\n'=cmd|calc,3\r\nPlain,\r\n`);
  });

  it('builds safe export file names', () => {
    expect(exportFileName('workforce.headcount_trend', today)).toBe(
      'workforce-headcount_trend-2026-10-06.csv',
    );
    expect(exportFileName('../../etc"\r\n', today)).toBe('etc-2026-10-06.csv');
    expect(exportFileName('', today)).toBe('report-2026-10-06.csv');
  });
});

describe('reporting registry', () => {
  it('declares unique keys, source permissions and supported filters', () => {
    const keys = REPORT_DEFINITIONS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const definition of REPORT_DEFINITIONS) {
      expect(definition.key.startsWith(`${definition.area}.`)).toBe(true);
      expect(definition.sourcePermissions.length).toBeGreaterThan(0);
      expect(requiredPermissions(definition)).toEqual([
        'report.read',
        ...definition.sourcePermissions,
      ]);
      expect(requiredPermissions(definition, true)).toContain('report.export');
      if (definition.groupBy) expect(definition.filters).toContain('groupBy');
      if (definition.dateMode === 'RANGE')
        expect(definition.filters).toEqual(
          expect.arrayContaining(['from', 'to']),
        );
      if (definition.sensitive)
        expect(definition.columns.map((c) => c.key)).toContain('suppressed');
    }
  });

  it('never labels a payroll amount as net pay while statutory deductions are not calculated', () => {
    for (const definition of REPORT_DEFINITIONS.filter(
      (r) => r.area === 'payroll',
    )) {
      const columns = definition.columns;
      // No money column is called "net"; net pay is a text column saying it is not calculated.
      expect(
        columns.filter(
          (c) =>
            c.type === 'money' &&
            /\bnet\b/i.test(c.label) &&
            !/\bnot net pay\b/i.test(c.label),
        ),
      ).toEqual([]);
      expect(columns.map((c) => c.key)).not.toContain('net');
      expect(columns).toEqual(
        expect.arrayContaining([
          { key: 'netPay', label: 'Net pay', type: 'string' },
          {
            key: 'grossLessRecordedDeductions',
            label: expect.stringMatching(
              /^Gross less recorded deductions \(not net pay\)$/i,
            ),
            type: 'money',
          },
          { key: 'deductions', label: 'Recorded deductions', type: 'money' },
        ]),
      );
      expect(definition.description).toMatch(/Net pay is not calculated/);
    }
  });

  it('keeps offboarding and documents behind their own permissions', () => {
    const source = (key: string) =>
      REPORT_DEFINITIONS.find((r) => r.key === key)!.sourcePermissions;
    expect(source('offboarding.workflows')).toEqual(['offboarding.read']);
    expect(source('onboarding.workflows')).toEqual(['onboarding.read']);
    expect(source('documents.expiry')).toEqual(['document.read']);
    expect(source('scheduling.adherence')).toEqual([
      'schedule.read',
      'time.view',
    ]);
    expect(
      REPORT_DEFINITIONS.filter((r) => r.area === 'payroll').every(
        (r) => r.placement === 'ORGANIZATION',
      ),
    ).toBe(true);
  });
});
