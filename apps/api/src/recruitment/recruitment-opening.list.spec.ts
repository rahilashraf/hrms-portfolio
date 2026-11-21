import {
  OPENING_LIST_LIMIT,
  RecruitmentOpeningService,
} from './recruitment-opening.service.js';

/** Phase 19: the openings list is capped (newest first) and says when it was cut. */
describe('RecruitmentOpeningService.list safety cap', () => {
  const opening = (index: number) => ({
    id: `opening-${index}`,
    organization: { id: 'org', name: 'Org' },
    code: `REQ-${index}`,
    title: 'Teacher',
    description: null,
    status: 'OPEN',
    statusReason: null,
    employmentType: 'FULL_TIME',
    openingCount: 1,
    hiredCount: 0,
    position: null,
    organizationalUnit: null,
    department: null,
    team: null,
    workLocation: null,
    hiringManager: null,
    recruiterUserId: null,
    expectedStartDate: null,
    postedOn: null,
    closesOn: null,
    compensationPayBasis: null,
    compensationCurrency: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  async function list(total: number) {
    const rows = Array.from({ length: total }, (_, index) => opening(index));
    const findMany = vi.fn(async ({ take }: { take: number }) =>
      rows.slice(0, take),
    );
    const groupBy = vi.fn(async () => []);
    const access = {
      visibleOpenings: vi.fn(async () => ({
        items: rows.map((row) => ({ opening: row, access: { canRead: true } })),
      })),
    };
    const service = new RecruitmentOpeningService(
      {
        jobOpening: { findMany },
        recruitmentApplication: { groupBy },
      } as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.list('user', 'org');
    return { result, findMany, groupBy };
  }

  it('returns everything below the cap with truncated: false', async () => {
    const { result } = await list(3);
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('cuts at the cap, flags it and counts applications only for the returned page', async () => {
    const { result, findMany, groupBy } = await list(OPENING_LIST_LIMIT + 7);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: OPENING_LIST_LIMIT + 1 }),
    );
    expect(result.items).toHaveLength(OPENING_LIST_LIMIT);
    expect(result.truncated).toBe(true);
    const where = (
      groupBy.mock.calls[0] as unknown as [
        { where: { openingId: { in: string[] } } },
      ]
    )[0].where;
    expect(where.openingId.in).toHaveLength(OPENING_LIST_LIMIT);
  });
});
