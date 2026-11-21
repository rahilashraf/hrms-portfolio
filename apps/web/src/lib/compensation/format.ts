import type { CompensationRecord, PayBasis, SalaryArrangement } from './types';

export { formatDateOnly, label } from '../time/format';

/**
 * Formats a decimal amount string ("62000.0000") for display without ever converting it to a
 * JavaScript number: thousands separators, at least two decimals, extra zero decimals dropped.
 */
export function formatAmount(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, integer, fraction = ''] = match;
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${grouped}.${decimals}`;
}

export function payBasisLabel(basis: PayBasis): string {
  return basis === 'HOURLY' ? 'Hourly' : 'Salary';
}

export function salaryArrangementLabel(arrangement: SalaryArrangement | null | undefined): string {
  if (arrangement === 'FIXED_PERIOD') return 'Fixed period';
  if (arrangement === 'CONTRACT_TOTAL') return 'Contract total';
  return 'Annual';
}

/** "CAD 24.50 / hour", "CAD 62,000.00 / year", or contracted salary terms. */
export function formatRate(
  rateAmount: string,
  currency: string,
  payBasis: PayBasis,
  arrangement: SalaryArrangement | null = payBasis === 'SALARY' ? 'ANNUAL' : null,
): string {
  if (payBasis === 'HOURLY') return `${currency} ${formatAmount(rateAmount)} / hour`;
  if (arrangement === 'FIXED_PERIOD') return `${currency} ${formatAmount(rateAmount)} / month`;
  if (arrangement === 'CONTRACT_TOTAL') return `${currency} ${formatAmount(rateAmount)} contract`;
  return `${currency} ${formatAmount(rateAmount)} / year`;
}

export function formatRecordRate(record: CompensationRecord): string {
  return formatRate(record.rateAmount, record.currency, record.payBasis, record.salaryArrangement);
}

export function formatPeriod(effectiveFrom: string, effectiveTo: string | null): string {
  const date = (value: string) => {
    const [year, month, day] = value.split('-');
    return `${month}/${day}/${year}`;
  };
  return effectiveTo
    ? `${date(effectiveFrom)} – ${date(effectiveTo)}`
    : `${date(effectiveFrom)} – ongoing`;
}

/** A rate as typed: a positive decimal with at most 15 integer digits and 4 decimals. */
export function isValidRate(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(trimmed) && /[1-9]/.test(trimmed);
}

/** Today as YYYY-MM-DD in the browser's zone (default form values only). */
export function todayIso(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PAID_MONTHS = 120;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Fixed-period paid months as typed: a whole number from 1 to 120, else null. */
export function parsePaidMonths(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d{0,2}$/.test(trimmed)) return null;
  const months = Number(trimmed);
  return months <= MAX_PAID_MONTHS ? months : null;
}

/** True for a YYYY-MM-DD date on the first day of a month. */
export function isFirstOfMonth(value: string): boolean {
  const match = DATE_PARTS.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 && match[3] === '01';
}

/**
 * The last day of the final paid calendar month of a fixed-period salary starting on the first of
 * a month (2026-09-01 + 10 months → 2027-06-30). Pure calendar arithmetic, no time zones; null
 * when the start is not the first of a month or the month count is out of range.
 */
export function fixedPeriodEnd(start: string, paidMonths: number): string | null {
  if (!isFirstOfMonth(start)) return null;
  if (!Number.isInteger(paidMonths) || paidMonths < 1 || paidMonths > MAX_PAID_MONTHS) {
    return null;
  }
  const match = DATE_PARTS.exec(start)!;
  const lastMonthIndex = Number(match[1]) * 12 + (Number(match[2]) - 1) + paidMonths - 1;
  const year = Math.floor(lastMonthIndex / 12);
  const month = (lastMonthIndex % 12) + 1;
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(daysInMonth(year, month), 2)}`;
}

/**
 * An exact decimal amount (up to 4 decimals) times a whole number, as a plain decimal string
 * ("4000" × 10 → "40000"). Uses BigInt on the amount scaled by 10^4, never floating point; the
 * BigInt() calls (not `n` literals) keep this valid for the ES2017 compile target.
 */
export function multiplyAmount(amount: string, factor: number): string | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(amount.trim());
  if (!match || !Number.isSafeInteger(factor) || factor < 0) return null;
  const scaled = BigInt(`${match[1]}${(match[2] ?? '').padEnd(4, '0')}`) * BigInt(factor);
  const digits = scaled.toString().padStart(5, '0');
  const fraction = digits.slice(-4).replace(/0+$/, '');
  return fraction ? `${digits.slice(0, -4)}.${fraction}` : digits.slice(0, -4);
}
