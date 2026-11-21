import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertTemplateWeights,
  calculateScore,
  evidenceContentHash,
  type ItemShape,
  missingRequired,
  normalizeAnswer,
  normalizeEmail,
  normalizeScore,
  parsePerformanceCode,
  parseScaleLevels,
} from './performance-domain.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { code: string })
      .code;
  }
  throw new Error('expected a failure');
};

const LEVELS = [
  { value: 1, label: 'Needs Improvement', description: null },
  { value: 2, label: 'Developing', description: null },
  { value: 3, label: 'Meets Expectations', description: null },
  { value: 4, label: 'Exceeds Expectations', description: null },
  { value: 5, label: 'Exceptional', description: null },
];

const rating = (
  id: string,
  weight: string | null,
  overrides: Partial<ItemShape> = {},
): ItemShape => ({
  id,
  itemType: 'RATING',
  respondent: 'REVIEWER',
  required: false,
  weight,
  scaleLevels: LEVELS,
  ...overrides,
});

describe('performance codes and scales', () => {
  it('normalizes codes', () => {
    expect(parsePerformanceCode(' annual-2026 ')).toBe('ANNUAL-2026');
    expect(code(() => parsePerformanceCode('x'))).toBe(
      'PERFORMANCE_CODE_INVALID',
    );
  });

  it('requires two unique whole levels and sorts them', () => {
    expect(
      parseScaleLevels([
        { value: 3, label: ' Meets ', description: null },
        { value: 1, label: 'Low', description: '' },
      ]),
    ).toEqual([
      { value: 1, label: 'Low', description: null },
      { value: 3, label: 'Meets', description: null },
    ]);
    expect(code(() => parseScaleLevels([LEVELS[0]!]))).toBe(
      'PERFORMANCE_SCALE_LEVELS_INVALID',
    );
    expect(code(() => parseScaleLevels([LEVELS[0]!, LEVELS[0]!]))).toBe(
      'PERFORMANCE_SCALE_LEVELS_INVALID',
    );
    expect(
      code(() =>
        parseScaleLevels([
          LEVELS[0]!,
          { value: 1.5, label: 'x', description: null },
        ]),
      ),
    ).toBe('PERFORMANCE_SCALE_LEVELS_INVALID');
  });
});

describe('template weights', () => {
  it('requires weights totalling 100 on every reviewer rating item', () => {
    expect(() =>
      assertTemplateWeights('WEIGHTED_AVERAGE', [
        rating('a', '60'),
        rating('b', '40'),
      ]),
    ).not.toThrow();
    expect(
      code(() =>
        assertTemplateWeights('WEIGHTED_AVERAGE', [
          rating('a', '60'),
          rating('b', '30'),
        ]),
      ),
    ).toBe('PERFORMANCE_WEIGHTS_INVALID');
    expect(
      code(() =>
        assertTemplateWeights('WEIGHTED_AVERAGE', [
          rating('a', '100'),
          rating('b', null),
        ]),
      ),
    ).toBe('PERFORMANCE_WEIGHTS_INVALID');
    // Self-only items never carry weight.
    expect(
      code(() =>
        assertTemplateWeights('WEIGHTED_AVERAGE', [
          rating('a', '100'),
          rating('s', '10', { respondent: 'SELF' }),
        ]),
      ),
    ).toBe('PERFORMANCE_WEIGHTS_INVALID');
  });

  it('allows no weights at all for unscored templates', () => {
    expect(() =>
      assertTemplateWeights('NONE', [rating('a', null)]),
    ).not.toThrow();
    expect(
      code(() => assertTemplateWeights('NONE', [rating('a', '100')])),
    ).toBe('PERFORMANCE_WEIGHTS_INVALID');
  });
});

describe('answers', () => {
  it('maps a rating to its level label and rejects other values', () => {
    expect(
      normalizeAnswer(rating('a', null), {
        ratingValue: 4,
        textValue: ' Great ',
      }),
    ).toEqual({
      ratingValue: 4,
      ratingLabel: 'Exceeds Expectations',
      numericValue: null,
      booleanValue: null,
      textValue: 'Great',
    });
    expect(
      code(() => normalizeAnswer(rating('a', null), { ratingValue: 9 })),
    ).toBe('PERFORMANCE_ANSWER_INVALID');
    expect(
      code(() => normalizeAnswer(rating('a', null), { booleanValue: true })),
    ).toBe('PERFORMANCE_ANSWER_INVALID');
  });

  it('checks scale bounds and required completeness per respondent', () => {
    const scale: ItemShape = {
      id: 's',
      itemType: 'SCALE',
      respondent: 'BOTH',
      required: true,
      weight: null,
      scaleMin: 1,
      scaleMax: 10,
    };
    expect(code(() => normalizeAnswer(scale, { numericValue: 11 }))).toBe(
      'PERFORMANCE_ANSWER_INVALID',
    );
    const text: ItemShape = {
      id: 't',
      itemType: 'TEXT',
      respondent: 'SELF',
      required: true,
      weight: null,
    };
    const answers = new Map([
      ['s', normalizeAnswer(scale, { numericValue: 7 })],
    ]);
    expect(missingRequired([scale, text], 'SELF', answers)).toEqual(['t']);
    expect(missingRequired([scale, text], 'REVIEWER', answers)).toEqual([]);
  });
});

describe('scoring', () => {
  const items = [rating('a', '50'), rating('b', '30'), rating('c', '20')];
  const answers = (values: Record<string, number>) =>
    new Map(
      Object.entries(values).map(([id, value]) => [
        id,
        normalizeAnswer(
          items.find((i) => i.id === id)!,
          { ratingValue: value },
        ),
      ]),
    );

  it('is the weighted average of rated items, half-up to 2 decimals', () => {
    // (50×4 + 30×3 + 20×5) / 100 = 3.90
    expect(
      calculateScore('WEIGHTED_AVERAGE', items, answers({ a: 4, b: 3, c: 5 })),
    ).toBe('3.90');
    // Unrated optional c is left out: (50×4 + 30×3) / 80 = 3.625 → 3.63
    expect(
      calculateScore('WEIGHTED_AVERAGE', items, answers({ a: 4, b: 3 })),
    ).toBe('3.63');
  });

  it('has no score with nothing rated or for unscored templates', () => {
    expect(calculateScore('WEIGHTED_AVERAGE', items, new Map())).toBeNull();
    expect(calculateScore('NONE', items, answers({ a: 4 }))).toBeNull();
    expect(calculateScore(null, items, answers({ a: 4 }))).toBeNull();
  });
});

describe('evidence', () => {
  it('derives percentage and pass/fail from the snapshotted threshold', () => {
    expect(normalizeScore({ score: '17', maxScore: 20 }, '80.00')).toEqual({
      score: '17.00',
      maxScore: '20.00',
      percentage: '85.00',
      passed: true,
    });
    expect(normalizeScore({ score: '15', maxScore: '20' }, '80')).toMatchObject(
      {
        percentage: '75.00',
        passed: false,
      },
    );
    // The source's own pass/fail wins.
    expect(
      normalizeScore({ score: '15', maxScore: '20', passed: true }, '80')
        .passed,
    ).toBe(true);
  });

  it('keeps ungraded completions and rejects impossible scores', () => {
    expect(normalizeScore({}, '80')).toEqual({
      score: null,
      maxScore: null,
      percentage: null,
      passed: null,
    });
    expect(normalizeScore({ score: '5' }, '80')).toMatchObject({
      score: '5.00',
      percentage: null,
    });
    expect(
      code(() => normalizeScore({ score: '21', maxScore: '20' }, null)),
    ).toBe('PERFORMANCE_EVIDENCE_SCORE_INVALID');
    expect(code(() => normalizeScore({ score: '-1' }, null))).toBe(
      'PERFORMANCE_EVIDENCE_SCORE_INVALID',
    );
    expect(code(() => normalizeScore({ maxScore: 0 }, null))).toBe(
      'PERFORMANCE_EVIDENCE_SCORE_INVALID',
    );
  });

  it('normalizes emails and hashes content deterministically', () => {
    expect(normalizeEmail('  Staff@Example.ORG ')).toBe('staff@example.org');
    expect(normalizeEmail('not an email')).toBeNull();
    const content = {
      title: 'Code of Conduct',
      completedAt: new Date('2026-09-01T10:00:00Z'),
      score: '17.00',
      maxScore: '20.00',
      passed: true,
      resultUrl: null,
      employmentAssignmentId: null,
    };
    expect(evidenceContentHash(content)).toBe(
      evidenceContentHash({ ...content }),
    );
    expect(evidenceContentHash(content)).not.toBe(
      evidenceContentHash({ ...content, score: '18.00' }),
    );
  });
});
