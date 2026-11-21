/**
 * Phase 20 — human-readable validation errors. API validation (class-validator) messages name
 * raw properties ("employeeNumber must be a string", "property foo should not exist"); these
 * are rewritten into sentences that name the field the way users see it.
 */

/** "employeeNumber" → "Employee number"; "items.0.amountCents" → "Amount cents". */
export function fieldLabel(property: string): string {
  const last =
    property
      .split('.')
      .filter((part) => !/^\d+$/.test(part))
      .pop() ?? property;
  const words = last
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : property;
}

const PROPERTY_FIRST =
  /^([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*) (must|should|is|has|each|cannot|can not|may)\b/;
const UNKNOWN_PROPERTY = /^property ([A-Za-z0-9_.]+) should not exist$/;

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export function humanizeValidationMessage(message: string): string {
  const unknown = UNKNOWN_PROPERTY.exec(message.trim());
  if (unknown) return `${fieldLabel(unknown[1]!)} is not allowed.`;
  const match = PROPERTY_FIRST.exec(message.trim());
  if (!match) return sentence(message);
  return sentence(`${fieldLabel(match[1]!)}${message.trim().slice(match[1]!.length)}`);
}

/**
 * Batch 3B — the request property an API validation message is about ("employeeNumber must be a
 * string" → "employeeNumber", "property foo should not exist" → "foo"), or null when the message
 * names none.
 */
export function validationProperty(message: string): string | null {
  const unknown = UNKNOWN_PROPERTY.exec(message.trim());
  if (unknown) return unknown[1]!;
  return PROPERTY_FIRST.exec(message.trim())?.[1] ?? null;
}

/** Humanizes each of the API's messages and joins them into one readable paragraph. */
export function humanizeValidationMessages(messages: readonly string[]): string {
  return messages.map(humanizeValidationMessage).filter(Boolean).join(' ');
}
