import type { PickerOption } from '../pickers/sources';
import type { RecordSource } from '../pickers/use-record-search';
import { recruitmentApi } from './api';
import type { RecruitmentOption, RecruitmentOptionKind } from './types';

/** A recruitment picker option (units, departments and teams carry their placement). */
export type RecruitmentPickerOption = PickerOption & Pick<RecruitmentOption, 'placement'>;

const PAGE = 20;

/**
 * Batch 7A — picker sources backed by GET /recruitment/options: positions and structures the
 * caller may place an opening on, work locations, hiring managers and staff (recruiter,
 * interviewers). recruitment.manage in the organization is enough — no employee.read or
 * role.assign — so a standard Recruiter never types an id.
 */
export function recruitmentOptionSource(
  organizationId: string,
  kind: RecruitmentOptionKind,
): RecordSource<RecruitmentPickerOption> {
  return {
    async search(query, cursor) {
      const page = await recruitmentApi.options(organizationId, kind, {
        ...(query ? { search: query } : {}),
        limit: PAGE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      return {
        items: page.items.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.description ? { description: item.description } : {}),
          ...(item.placement ? { placement: item.placement } : {}),
        })),
        next: page.nextAfterId,
      };
    },
  };
}
