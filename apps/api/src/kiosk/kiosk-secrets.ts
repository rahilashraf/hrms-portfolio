import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Phase 9.5 — secrets of the attendance kiosk. Device secrets and interaction tokens are random
 * 32-byte values stored only as SHA-256 hashes (like sessions and account tokens). Enrollment
 * codes are short, typed once at the device, short-lived and rate-limited. PINs are 6 digits,
 * hashed with argon2id elsewhere.
 */
export const KIOSK_COOKIE_NAME = 'hrms_kiosk';
export const KIOSK_COOKIE_PATH = '/kiosk';
/** The device secret has no server-side expiry: an administrator rotates or revokes it. */
export const KIOSK_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;
export const INTERACTION_TTL_MS = 90_000;
export const PIN_MAX_FAILED_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

/** Unambiguous characters (no 0/O, 1/I/L) for codes typed by a person. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** 10 characters of a 31-symbol alphabet (~49 bits), shown as XXXXX-XXXXX. */
export function enrollmentCode(): string {
  let code = '';
  for (let i = 0; i < 10; i += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Codes are compared case- and separator-insensitively. */
export function normalizeEnrollmentCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function randomPin(): string {
  let pin: string;
  do {
    pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (weakPin(pin));
  return pin;
}

export const PIN_PATTERN = /^\d{6}$/;

/** Trivial PINs (one repeated digit, or a straight run like 123456 / 654321) are refused. */
export function weakPin(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = pin.split('').map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]!);
  return (
    steps.every((step) => step === 1) || steps.every((step) => step === -1)
  );
}

export function normalizeEmployeeNumber(value: string): string {
  return value.trim().toUpperCase();
}
