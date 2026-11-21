export * from '../common/domain-support.js';
export type {
  DomainClient as LeaveClient,
  DomainRequestContext as LeaveRequestContext,
} from '../common/domain-support.js';
export { domainError as leaveError } from '../common/domain-support.js';
import { BadRequestException } from '@nestjs/common';
import { isIanaTimezone } from '../common/timezone.js';

// ─── Timezone resolution ─────────────────────────────────────────────────────

/**
 * Leave's local dates are interpreted in the assignment position's WorkLocation timezone, then
 * the organization's. There is no silent UTC fallback: an unresolvable timezone is an error.
 */
export function resolveLeaveTimezone(position: {
  workLocation: { timezone: string | null } | null;
  organization: { timezone: string | null };
}): string {
  for (const candidate of [
    position.workLocation?.timezone,
    position.organization.timezone,
  ]) {
    if (candidate && isIanaTimezone(candidate)) return candidate.trim();
  }
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'LEAVE_TIMEZONE_UNRESOLVED',
    message:
      'The assignment has no timezone: set a WorkLocation timezone on its position or a timezone on its organization.',
  });
}
