import { enumLabel } from '../../lib/ui/labels';
import { badgeClass, type Tone } from './tokens';

/**
 * Batch 10A — one status pill for every module: the status's words are always shown (never color
 * alone) and the color comes from one central map, so the same status looks the same everywhere.
 *
 * - `success`: done or in force (ACTIVE, APPROVED, PUBLISHED, COMPLETED, PAID…).
 * - `info`: moving through a process (SUBMITTED, IN_PROGRESS, SCHEDULED…).
 * - `warning`: waiting on someone or about to lapse (PENDING, CHANGES_REQUESTED, EXPIRING_SOON…).
 * - `danger`: refused or failed (REJECTED, FAILED, EXPIRED, INFECTED…).
 * - `neutral`: inactive, historical or not started (DRAFT, ARCHIVED, CANCELLED, SUPERSEDED…).
 *
 * Unknown statuses are neutral. A module with a status whose meaning differs passes `tone`.
 */
export const STATUS_TONE: Readonly<Record<string, Tone>> = {
  ACTIVE: 'success',
  APPROVED: 'success',
  PUBLISHED: 'success',
  COMPLETED: 'success',
  COMPLETE: 'success',
  CURRENT: 'success',
  FINALIZED: 'success',
  PAID: 'success',
  ACCEPTED: 'success',
  HIRED: 'success',
  ACKNOWLEDGED: 'success',
  ENABLED: 'success',
  CONNECTED: 'success',
  DELIVERED: 'success',
  SENT: 'success',
  VALID: 'success',
  CLEAN: 'success',
  SATISFIED: 'success',
  ENROLLED: 'success',
  SUBMITTED: 'info',
  IN_PROGRESS: 'info',
  IN_REVIEW: 'info',
  OPEN: 'info',
  SCHEDULED: 'info',
  PLANNED: 'info',
  CALCULATED: 'info',
  PROCESSING: 'info',
  RUNNING: 'info',
  OFFERED: 'info',
  PENDING: 'warning',
  AWAITING: 'warning',
  CHANGES_REQUESTED: 'warning',
  ON_HOLD: 'warning',
  OVERDUE: 'warning',
  EXPIRING_SOON: 'warning',
  MISSING: 'warning',
  RETRYING: 'warning',
  REJECTED: 'danger',
  DECLINED: 'danger',
  FAILED: 'danger',
  EXPIRED: 'danger',
  INFECTED: 'danger',
  BLOCKED: 'danger',
  ERROR: 'danger',
  DRAFT: 'neutral',
  ARCHIVED: 'neutral',
  INACTIVE: 'neutral',
  CANCELLED: 'neutral',
  WITHDRAWN: 'neutral',
  REVOKED: 'neutral',
  SUPERSEDED: 'neutral',
  RETIRED: 'neutral',
  ENDED: 'neutral',
  CLOSED: 'neutral',
  DISABLED: 'neutral',
  NOT_STARTED: 'neutral',
  NOT_SCANNED: 'neutral',
};

/** The tone of a status (case-insensitive), neutral when unknown. */
export function statusTone(status: string): Tone {
  return STATUS_TONE[status.toUpperCase()] ?? 'neutral';
}

export function StatusBadge({
  status,
  label,
  tone,
}: {
  /** The status code (e.g. `PENDING`); also chooses the color unless `tone` is given. */
  status: string;
  /** The words shown; defaults to the status in readable form ("Changes requested"). */
  label?: string;
  tone?: Tone;
}) {
  return (
    <span className={badgeClass(tone ?? statusTone(status))} data-status={status}>
      {label ?? enumLabel(status)}
    </span>
  );
}
