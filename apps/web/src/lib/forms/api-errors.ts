import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { AuthApiError } from '../auth/types';
import { humanizeValidationMessage, validationProperty } from '../ui/validation';

export interface ApiErrorMapping<T extends FieldValues> {
  /**
   * API request properties → form fields. A message about `items.0.amount` matches
   * `items.0.amount`, then `items`.
   */
  fields?: Partial<Record<string, Path<T>>>;
  /** Domain error codes (`details.code`) → the field they concern, with the text to show. */
  codes?: Partial<Record<string, { field?: Path<T>; message: string }>>;
}

export interface ApiErrorOutcome {
  /** How many messages were shown on a field. */
  placed: number;
  /**
   * What is left for the form-level message: the validation messages no field took, or a coded
   * message without a field. Null when everything was placed, or the error was not a
   * validation or coded error (then show the module's own error text).
   */
  message: string | null;
}

/**
 * Batch 3B — puts an API refusal on the form fields it concerns (React Hook Form `setError`):
 * class-validator 400 messages by the property they name, domain error codes by the mapping.
 * The rest comes back as the form-level message.
 */
export function applyApiErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  mapping: ApiErrorMapping<T> = {},
): ApiErrorOutcome {
  if (!(error instanceof AuthApiError)) return { placed: 0, message: null };
  const code = typeof error.details?.code === 'string' ? error.details.code : undefined;
  const coded = code ? mapping.codes?.[code] : undefined;
  if (coded) {
    if (coded.field) {
      setError(coded.field, { type: 'server', message: coded.message }, { shouldFocus: true });
      return { placed: 1, message: null };
    }
    return { placed: 0, message: coded.message };
  }
  const raw = error.details?.message;
  if ((error.status !== 400 && error.status !== 422) || !Array.isArray(raw)) {
    return { placed: 0, message: null };
  }
  let placed = 0;
  const unplaced: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const property = validationProperty(item);
    const field = property
      ? (mapping.fields?.[property] ?? mapping.fields?.[property.split('.')[0]!])
      : undefined;
    const text = humanizeValidationMessage(item);
    if (field) {
      setError(field, { type: 'server', message: text }, { shouldFocus: placed === 0 });
      placed += 1;
    } else {
      unplaced.push(text);
    }
  }
  return { placed, message: unplaced.length > 0 ? unplaced.join(' ') : null };
}
