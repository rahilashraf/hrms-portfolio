'use client';

import type { Answer, AnswerView, FormItem } from '../../../lib/performance/types';

// Batch 10E-2: moved from review-page.tsx unchanged.
export type Part = 'SELF' | 'REVIEWER';

export const answeredBy = (item: FormItem, part: Part) =>
  item.respondent === 'BOTH' || item.respondent === part;

export const toAnswer = (itemId: string, view: AnswerView | undefined): Answer => ({
  itemId,
  ratingValue: view?.ratingValue ?? null,
  numericValue: view?.numericValue ?? null,
  booleanValue: view?.booleanValue ?? null,
  textValue: view?.textValue ?? null,
});

export type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;
