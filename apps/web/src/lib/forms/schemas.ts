import { z } from './zod';

/**
 * Batch 3B — small Zod building blocks for forms, with messages that name the field the way
 * users see it. Keep the limits in line with the API DTOs.
 */

/** Required text, trimmed, with a maximum length. */
export const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `Enter ${label}.`).max(max, `Use at most ${max} characters.`);

/** Optional text, trimmed; empty becomes null. */
export const optionalText = (max = 1000) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .transform((value) => (value === '' ? null : value));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: 2026-02-30 is refused (Date would roll it over to March). */
const validDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** A required calendar date from a date input (YYYY-MM-DD). */
export const dateString = (label: string) =>
  z.string().refine((value) => validDate(value), `Enter ${label}.`);

/** An optional calendar date; empty becomes null. */
export const optionalDateString = () =>
  z
    .string()
    .refine((value) => value === '' || validDate(value), 'Enter a valid date.')
    .transform((value) => (value === '' ? null : value));

/** A record chosen in a picker (or typed as an identifier). */
export const recordId = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `Choose ${label}.`);
