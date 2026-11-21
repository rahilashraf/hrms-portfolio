import { enumLabel } from '../ui/labels';
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const sign = minutes < 0 ? '-' : '';
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remaining = absolute % 60;
  if (hours === 0) return `${sign}${remaining}m`;
  if (remaining === 0) return `${sign}${hours}h`;
  return `${sign}${hours}h ${remaining}m`;
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${month}/${day}/${year}`;
}

export function formatInstant(value: string | null | undefined, timezone?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone || 'UTC',
  }).format(date);
}

/** User-facing label for an API enum key (shared terminology, see lib/ui/labels). */
export function label(value: string | null | undefined): string {
  return enumLabel(value);
}
