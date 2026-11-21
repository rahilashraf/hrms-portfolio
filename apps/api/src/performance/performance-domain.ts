import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { domainError } from '../common/domain-support.js';
import {
  Prisma,
  type PerformanceItemType,
  type PerformanceRespondent,
  type PerformanceScoringMode,
} from '../generated/prisma/client.js';

/**
 * Phase 12 — pure Performance domain rules (no Nest services, no database). Each rule mirrors,
 * and fails before, the matching constraint of the phase12 performance migrations.
 */

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** Codes of competencies, scales, templates, cycles and evidence sources. */
const CODE = /^[A-Z0-9_-]{2,64}$/;
/** Free text answers and comments (generous, but bounded). */
export const MAX_TEXT = 10_000;

function invalid(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new BadRequestException(domainError(400, code, message, extra));
}

export function parsePerformanceCode(value: unknown, field = 'code'): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE.test(code)) {
    invalid(
      'PERFORMANCE_CODE_INVALID',
      `${field} must be 2–64 characters: letters, digits, "_" or "-" (e.g. "ANNUAL-2026").`,
    );
  }
  return code;
}

/** Trimmed non-empty text, or null when optional and blank. */
export function parseText(
  value: unknown,
  field: string,
  options: { required?: boolean; max?: number } = {},
): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (options.required)
      invalid('PERFORMANCE_TEXT_REQUIRED', `${field} is required.`);
    return null;
  }
  if (text.length > (options.max ?? MAX_TEXT)) {
    invalid('PERFORMANCE_TEXT_TOO_LONG', `${field} is too long.`);
  }
  return text;
}

// ─── Rating scales ─────────────────────────────────────────────────────────────

export interface ScaleLevel {
  value: number;
  label: string;
  description: string | null;
}

/** Levels of a scale: whole values 0–100, unique, at least two, sorted ascending. */
export function parseScaleLevels(levels: readonly ScaleLevel[]): ScaleLevel[] {
  if (levels.length < 2) {
    invalid(
      'PERFORMANCE_SCALE_LEVELS_INVALID',
      'A rating scale needs at least two levels.',
    );
  }
  const seen = new Set<number>();
  const parsed = levels.map((level) => {
    if (
      !Number.isInteger(level.value) ||
      level.value < 0 ||
      level.value > 100
    ) {
      invalid(
        'PERFORMANCE_SCALE_LEVELS_INVALID',
        'Level values are whole numbers from 0 to 100.',
      );
    }
    if (seen.has(level.value)) {
      invalid(
        'PERFORMANCE_SCALE_LEVELS_INVALID',
        'Level values must be unique.',
      );
    }
    seen.add(level.value);
    return {
      value: level.value,
      label: parseText(level.label, 'label', { required: true, max: 120 })!,
      description: parseText(level.description, 'description', { max: 500 }),
    };
  });
  return parsed.sort((a, b) => a.value - b.value);
}

// ─── Templates ─────────────────────────────────────────────────────────────────

export interface ItemShape {
  id: string;
  itemType: PerformanceItemType;
  respondent: PerformanceRespondent;
  required: boolean;
  /** Decimal string, e.g. "25.00". */
  weight: string | null;
  scaleLevels?: ScaleLevel[] | null;
  scaleMin?: number | null;
  scaleMax?: number | null;
}

export function answeredBy(
  item: Pick<ItemShape, 'respondent'>,
  respondent: 'SELF' | 'REVIEWER',
): boolean {
  return item.respondent === 'BOTH' || item.respondent === respondent;
}

/** Reviewer RATING items: the only ones that can carry weight and enter the score. */
function scorable(item: Pick<ItemShape, 'itemType' | 'respondent'>) {
  return item.itemType === 'RATING' && item.respondent !== 'SELF';
}

/**
 * Weights: WEIGHTED_AVERAGE templates weigh every reviewer RATING item (> 0) and the weights
 * total exactly 100; NONE templates carry no weights. Self-only and non-rating items never do.
 */
export function assertTemplateWeights(
  scoringMode: PerformanceScoringMode,
  items: ReadonlyArray<
    Pick<ItemShape, 'id' | 'itemType' | 'respondent' | 'weight'>
  >,
) {
  if (scoringMode === 'NONE') {
    if (items.some((item) => item.weight !== null)) {
      invalid(
        'PERFORMANCE_WEIGHTS_INVALID',
        'Only weighted templates carry item weights.',
      );
    }
    return;
  }
  const weighted = items.filter(scorable);
  if (weighted.length === 0) {
    invalid(
      'PERFORMANCE_WEIGHTS_INVALID',
      'A weighted template needs at least one reviewer rating item.',
    );
  }
  if (items.some((item) => !scorable(item) && item.weight !== null)) {
    invalid(
      'PERFORMANCE_WEIGHTS_INVALID',
      'Only reviewer rating items carry weights.',
    );
  }
  if (
    weighted.some(
      (item) => item.weight === null || new Decimal(item.weight).lte(0),
    )
  ) {
    invalid(
      'PERFORMANCE_WEIGHTS_INVALID',
      'Every reviewer rating item needs a weight above 0.',
    );
  }
  const total = weighted.reduce(
    (sum, item) => sum.plus(item.weight!),
    new Decimal(0),
  );
  if (!total.eq(100)) {
    invalid(
      'PERFORMANCE_WEIGHTS_INVALID',
      `Item weights must total 100 (they total ${total.toFixed(2)}).`,
      {
        total: total.toFixed(2),
      },
    );
  }
}

// ─── Answers ───────────────────────────────────────────────────────────────────

export interface AnswerInput {
  ratingValue?: number | null;
  numericValue?: number | null;
  booleanValue?: boolean | null;
  textValue?: string | null;
}

export interface Answer {
  ratingValue: number | null;
  ratingLabel: string | null;
  numericValue: number | null;
  booleanValue: boolean | null;
  textValue: string | null;
}

/**
 * Validates and normalizes an answer to one item. Every type allows an optional comment
 * (textValue); the value itself must match the item type. An empty answer is allowed in a
 * draft (completeness is checked on submit).
 */
export function normalizeAnswer(item: ItemShape, input: AnswerInput): Answer {
  const textValue = parseText(input.textValue, 'Comment');
  const answer: Answer = {
    ratingValue: null,
    ratingLabel: null,
    numericValue: null,
    booleanValue: null,
    textValue,
  };
  const hasRating =
    input.ratingValue !== undefined && input.ratingValue !== null;
  const hasNumber =
    input.numericValue !== undefined && input.numericValue !== null;
  const hasBoolean =
    input.booleanValue !== undefined && input.booleanValue !== null;
  const unexpected = (field: string) =>
    invalid(
      'PERFORMANCE_ANSWER_INVALID',
      `${field} does not apply to this item.`,
      {
        itemId: item.id,
      },
    );
  if (item.itemType !== 'RATING' && hasRating) unexpected('ratingValue');
  if (item.itemType !== 'SCALE' && hasNumber) unexpected('numericValue');
  if (item.itemType !== 'YES_NO' && hasBoolean) unexpected('booleanValue');
  if (hasRating) {
    const level = (item.scaleLevels ?? []).find(
      (l) => l.value === input.ratingValue,
    );
    if (!level) {
      invalid(
        'PERFORMANCE_ANSWER_INVALID',
        "The rating is not a level of the item's scale.",
        {
          itemId: item.id,
        },
      );
    }
    answer.ratingValue = level.value;
    answer.ratingLabel = level.label;
  }
  if (hasNumber) {
    const value = input.numericValue!;
    if (
      !Number.isInteger(value) ||
      value < item.scaleMin! ||
      value > item.scaleMax!
    ) {
      invalid(
        'PERFORMANCE_ANSWER_INVALID',
        `The value must be a whole number from ${item.scaleMin} to ${item.scaleMax}.`,
        { itemId: item.id },
      );
    }
    answer.numericValue = value;
  }
  if (hasBoolean) answer.booleanValue = input.booleanValue!;
  return answer;
}

/** Whether an answer satisfies a required item. */
export function isAnswered(
  item: Pick<ItemShape, 'itemType'>,
  answer: Answer | undefined,
) {
  if (!answer) return false;
  switch (item.itemType) {
    case 'RATING':
      return answer.ratingValue !== null;
    case 'SCALE':
      return answer.numericValue !== null;
    case 'YES_NO':
      return answer.booleanValue !== null;
    default:
      return answer.textValue !== null;
  }
}

/** Required items of a respondent left unanswered (by item id). */
export function missingRequired(
  items: readonly ItemShape[],
  respondent: 'SELF' | 'REVIEWER',
  answers: ReadonlyMap<string, Answer>,
): string[] {
  return items
    .filter((item) => item.required && answeredBy(item, respondent))
    .filter((item) => !isAnswered(item, answers.get(item.id)))
    .map((item) => item.id);
}

// ─── Scoring ───────────────────────────────────────────────────────────────────

/**
 * WEIGHTED_AVERAGE score (rule PERFORMANCE_WEIGHTED_AVERAGE v1): over the reviewer's rated,
 * weighted RATING items, Σ(weight × value) ÷ Σ(weight), rounded half-up to 2 decimals.
 * Unrated (optional) items are left out and the remaining weights renormalize; with nothing
 * rated there is no score. Self answers and evidence never count. NONE: never a score.
 */
export function calculateScore(
  scoringMode: PerformanceScoringMode | null,
  items: readonly ItemShape[],
  reviewerAnswers: ReadonlyMap<string, Answer>,
): string | null {
  if (scoringMode !== 'WEIGHTED_AVERAGE') return null;
  let weights = new Decimal(0);
  let total = new Decimal(0);
  for (const item of items) {
    if (!scorable(item) || item.weight === null) continue;
    const value = reviewerAnswers.get(item.id)?.ratingValue;
    if (value === null || value === undefined) continue;
    weights = weights.plus(item.weight);
    total = total.plus(new Decimal(item.weight).times(value));
  }
  if (weights.isZero()) return null;
  return total
    .div(weights)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

// ─── Evidence ──────────────────────────────────────────────────────────────────

/** Score fields of an assessment result, all optional (an ungraded form has none). */
export interface ResultScore {
  score?: string | number | null;
  maxScore?: string | number | null;
  passed?: boolean | null;
}

export interface NormalizedScore {
  score: string | null;
  maxScore: string | null;
  percentage: string | null;
  passed: boolean | null;
}

function decimalOrNull(
  value: string | number | null | undefined,
  field: string,
) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(text)) {
    invalid(
      'PERFORMANCE_EVIDENCE_SCORE_INVALID',
      `${field} must be a non-negative number with at most two decimals.`,
    );
  }
  return new Decimal(text);
}

/**
 * Score, maximum, percentage and pass/fail of a result. The percentage is score ÷ maximum ×
 * 100 (half-up, 2 decimals) when both are known. Pass/fail is what the source reported, else
 * percentage ≥ the threshold in force when imported (snapshotted), else unknown. A completion
 * without a score stays valid evidence.
 */
export function normalizeScore(
  input: ResultScore,
  passThresholdPercent: string | null,
): NormalizedScore {
  const score = decimalOrNull(input.score, 'score');
  const maxScore = decimalOrNull(input.maxScore, 'maxScore');
  if (maxScore && maxScore.isZero()) {
    invalid('PERFORMANCE_EVIDENCE_SCORE_INVALID', 'maxScore must be above 0.');
  }
  if (score && maxScore && score.gt(maxScore)) {
    invalid(
      'PERFORMANCE_EVIDENCE_SCORE_INVALID',
      'score cannot exceed maxScore.',
    );
  }
  const percentage =
    score && maxScore
      ? score.div(maxScore).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : null;
  const passed =
    input.passed ??
    (percentage && passThresholdPercent !== null
      ? percentage.gte(passThresholdPercent)
      : null);
  return {
    score: score?.toFixed(2) ?? null,
    maxScore: maxScore?.toFixed(2) ?? null,
    percentage: percentage?.toFixed(2) ?? null,
    passed,
  };
}

/** Lower-cased, trimmed email for matching (null when absent or malformed). */
export function normalizeEmail(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Hash of the meaningful content of an external result: a re-delivery with the same hash is
 * a duplicate (no-op); a different hash is a correction (new revision).
 */
export function evidenceContentHash(content: {
  title: string;
  completedAt: Date;
  score: string | null;
  maxScore: string | null;
  passed: boolean | null;
  resultUrl: string | null;
  employmentAssignmentId: string | null;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        content.title,
        content.completedAt.toISOString(),
        content.score,
        content.maxScore,
        content.passed,
        content.resultUrl,
        content.employmentAssignmentId,
      ]),
    )
    .digest('hex');
}
