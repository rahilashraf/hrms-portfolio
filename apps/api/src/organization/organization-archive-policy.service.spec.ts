/* oxlint-disable typescript/unbound-method */
import type { Prisma } from '../generated/prisma/client.js';
import { OrganizationArchivePolicyService } from './organization-archive-policy.service.js';

describe('OrganizationArchivePolicyService', () => {
  const tx = {
    organizationalUnit: { count: vi.fn() },
    department: { count: vi.fn() },
    team: { count: vi.fn() },
    position: { count: vi.fn() },
    jobTitle: { count: vi.fn() },
    workLocation: { count: vi.fn() },
  } as unknown as Prisma.TransactionClient;
  const policy = new OrganizationArchivePolicyService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tx.organizationalUnit.count).mockResolvedValue(0);
    vi.mocked(tx.department.count).mockResolvedValue(0);
    vi.mocked(tx.team.count).mockResolvedValue(0);
    vi.mocked(tx.position.count).mockResolvedValue(0);
    vi.mocked(tx.jobTitle.count).mockResolvedValue(0);
    vi.mocked(tx.workLocation.count).mockResolvedValue(0);
  });

  it('detects every active organization descendant resource type', async () => {
    vi.mocked(tx.workLocation.count).mockResolvedValue(1);

    await expect(
      policy.hasActiveOrganizationChildren(tx, 'organization-a'),
    ).resolves.toBe(true);
  });

  it('detects child units, Departments, direct Teams, and direct Positions', async () => {
    vi.mocked(tx.team.count).mockResolvedValue(1);

    await expect(policy.hasActiveUnitChildren(tx, 'unit-a')).resolves.toBe(
      true,
    );
    expect(tx.team.count).toHaveBeenCalledWith({
      where: { organizationalUnitId: 'unit-a', archivedAt: null },
    });
  });

  it('blocks Department archive for active Teams or Positions', async () => {
    vi.mocked(tx.position.count).mockResolvedValue(1);

    await expect(
      policy.hasActiveDepartmentChildren(tx, 'department-a'),
    ).resolves.toBe(true);
  });

  it.each([
    ['Team', 'hasActiveTeamPositions', 'team-a', 'teamId'],
    ['JobTitle', 'hasActiveJobTitlePositions', 'title-a', 'jobTitleId'],
    [
      'WorkLocation',
      'hasActiveWorkLocationPositions',
      'location-a',
      'workLocationId',
    ],
  ] as const)(
    'detects active Position references to a %s',
    async (_label, method, id, field) => {
      vi.mocked(tx.position.count).mockResolvedValue(1);

      await expect(policy[method](tx, id)).resolves.toBe(1);
      expect(tx.position.count).toHaveBeenCalledWith({
        where: { [field]: id, archivedAt: null },
      });
    },
  );
});
