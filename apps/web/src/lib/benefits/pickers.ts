import type { PickerOption } from '../pickers/sources';
import type { RecordSource } from '../pickers/use-record-search';
import { benefitsApi } from './api';
import type { BenefitOptionKind } from './types';

/**
 * Batch 7C (C7): picker sources backed by GET /benefits/options — the caller's benefit
 * permissions decide what is offered (no employee.read or organization.read needed).
 */
export function benefitOptionSource(
  organizationId: string,
  kind: BenefitOptionKind,
  filters: { employeeId?: string } = {},
): RecordSource<PickerOption & { employeeId?: string }> {
  return {
    async search(query, cursor) {
      const page = await benefitsApi.options(organizationId, kind, {
        ...(query ? { search: query } : {}),
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        limit: 20,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return { items: page.items, next: page.nextAfterId };
    },
  };
}
