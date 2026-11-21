import type { PickerOption } from '../pickers/sources';
import type { RecordSource } from '../pickers/use-record-search';
import { performanceApi } from './api';
import type { PerformanceOptionKind } from './types';

/**
 * Batch 7B (D7): picker sources backed by GET /performance/options — the caller's performance
 * permissions decide what is offered (no employee.read, organization.read or role.assign).
 */
export function performanceOptionSource(
  organizationId: string,
  kind: PerformanceOptionKind,
  filters: { employeeId?: string } = {},
): RecordSource<PickerOption & { employeeId?: string }> {
  return {
    async search(query, cursor) {
      const page = await performanceApi.options(organizationId, kind, {
        ...(query ? { search: query } : {}),
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        limit: 20,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return { items: page.items, next: page.nextAfterId };
    },
  };
}
