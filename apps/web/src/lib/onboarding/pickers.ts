import type { PickerOption } from '../pickers/sources';
import type { RecordSource } from '../pickers/use-record-search';
import { onboardingApi } from './api';
import type { OnboardingOptionKind, WorkflowKind } from './types';

const PAGE = 20;

/**
 * Batch 7A — record sources over GET /onboarding/options: they need only onboarding / offboarding
 * permissions (no role.assign or employee.read), and the API returns only what the caller may use.
 *
 * - owners: eligible task owners in the organization;
 * - assignments: assignments the caller may start `workflowKind` on (offboarding includes ended
 *   ones); the option id is the employment assignment id;
 * - hires: recruitment hires not yet onboarded (a cancelled onboarding may be restarted).
 */
export function onboardingOptionSource(
  organizationId: string,
  kind: OnboardingOptionKind,
  workflowKind?: WorkflowKind,
): RecordSource<PickerOption> {
  return {
    async search(query, cursor) {
      const page = await onboardingApi.options(organizationId, kind, {
        ...(workflowKind ? { workflowKind } : {}),
        ...(query ? { search: query } : {}),
        ...(cursor ? { afterId: cursor } : {}),
        limit: PAGE,
      });
      return {
        items: page.items.map((option) => ({
          id: option.id,
          label: option.label,
          description:
            kind === 'hire' && option.restartable
              ? [option.description, 'Earlier onboarding cancelled — starts a new one']
                  .filter(Boolean)
                  .join(' · ')
              : option.description,
        })),
        next: page.nextAfterId,
      };
    },
  };
}
