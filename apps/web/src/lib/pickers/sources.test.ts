import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  employeeApi: {
    list: vi.fn(),
    listPositionOptions: vi.fn(),
    listManagerAssignmentOptions: vi.fn(),
    listPersonOptions: vi.fn(),
  },
  authorizationApi: { searchUsers: vi.fn() },
  recruitmentApi: { candidates: vi.fn() },
}));
vi.mock('../employee/api', () => ({ employeeApi: mocks.employeeApi }));
vi.mock('../authorization/api', () => ({ authorizationApi: mocks.authorizationApi }));
vi.mock('../recruitment/api', () => ({ recruitmentApi: mocks.recruitmentApi }));

import {
  candidateSource,
  employeeSource,
  listSource,
  managerAssignmentSource,
  personSource,
  positionSource,
  userSource,
} from './sources';

beforeEach(() => vi.clearAllMocks());

describe('picker sources', () => {
  it('searches employees within an organization and follows nextAfterId', async () => {
    mocks.employeeApi.list.mockResolvedValue({
      items: [
        {
          id: 'emp-1',
          employeeNumber: 'E-1',
          status: 'ACTIVE',
          person: { firstName: 'Ada', lastName: 'Lovelace', middleName: null, preferredName: null },
          displayAssignment: { position: { name: 'Analyst' }, organization: { name: 'Northwind' } },
        },
      ],
      nextAfterId: 'emp-1',
    });
    const page = await employeeSource({ organizationId: 'org-1', status: 'ACTIVE' }).search(
      'ada',
      'emp-0',
    );
    expect(mocks.employeeApi.list).toHaveBeenCalledWith({
      search: 'ada',
      organizationId: 'org-1',
      status: 'ACTIVE',
      limit: 20,
      afterId: 'emp-0',
    });
    expect(page).toEqual({
      items: [{ id: 'emp-1', label: 'Ada Lovelace', description: 'E-1 · Analyst · Northwind' }],
      next: 'emp-1',
    });
  });

  it('maps positions, manager assignments and people, marking existing employees', async () => {
    mocks.employeeApi.listPositionOptions.mockResolvedValue({
      items: [
        {
          id: 'pos-1',
          name: 'Analyst',
          code: 'AN',
          jobTitle: { name: 'Analyst' },
          organization: { name: 'Northwind' },
        },
      ],
      nextAfterId: null,
    });
    expect((await positionSource({ organizationId: 'org-1' }).search('', null)).items).toEqual([
      { id: 'pos-1', label: 'Analyst', description: 'AN · Analyst · Northwind' },
    ]);
    expect(mocks.employeeApi.listPositionOptions).toHaveBeenCalledWith({
      organizationId: 'org-1',
      limit: 20,
    });

    mocks.employeeApi.listManagerAssignmentOptions.mockResolvedValue({
      items: [
        {
          assignmentId: 'asg-9',
          displayName: 'Grace Hopper',
          employeeNumber: 'E-9',
          position: { name: 'Lead' },
          organization: { name: 'Northwind' },
        },
      ],
      nextAfterId: null,
    });
    const managers = await managerAssignmentSource('asg-1').search('gr', null);
    expect(mocks.employeeApi.listManagerAssignmentOptions).toHaveBeenCalledWith({
      subordinateAssignmentId: 'asg-1',
      search: 'gr',
      limit: 20,
    });
    expect(managers.items[0]).toEqual({
      id: 'asg-9',
      label: 'Grace Hopper',
      description: 'E-9 · Lead · Northwind',
    });

    mocks.employeeApi.listPersonOptions.mockResolvedValue({
      items: [
        {
          id: 'p-1',
          firstName: 'Alan',
          lastName: 'Turing',
          middleName: null,
          preferredName: null,
          personalEmail: 'alan@example.com',
          hasEmployee: true,
          hasUser: false,
        },
      ],
      nextAfterId: null,
    });
    expect((await personSource().search('', null)).items[0]).toMatchObject({
      id: 'p-1',
      label: 'Alan Turing',
      disabledReason: 'Already an employee',
    });
  });

  it('pages users with nextCursor and marks invited accounts when only active ones fit', async () => {
    mocks.authorizationApi.searchUsers.mockResolvedValue({
      items: [
        {
          id: 'u-1',
          email: 'ada@example.com',
          status: 'ACTIVE',
          displayName: 'Ada',
          employeeNumber: 'E-1',
        },
        {
          id: 'u-2',
          email: 'new@example.com',
          status: 'INVITED',
          displayName: null,
          employeeNumber: null,
        },
      ],
      nextCursor: 'u-2',
    });
    const page = await userSource('org-1', { activeOnly: true }).search('a', 'u-0');
    expect(mocks.authorizationApi.searchUsers).toHaveBeenCalledWith('org-1', 'a', 'u-0', 20);
    expect(page).toEqual({
      items: [
        { id: 'u-1', label: 'Ada', description: 'ada@example.com · E-1' },
        { id: 'u-2', label: 'new@example.com', disabledReason: 'Not activated yet' },
      ],
      next: 'u-2',
    });
  });

  it('excludes the current candidate and marks merged ones', async () => {
    mocks.recruitmentApi.candidates.mockResolvedValue({
      items: [
        {
          id: 'c-1',
          displayName: 'Self',
          email: null,
          internal: false,
          mergedIntoCandidateId: null,
        },
        {
          id: 'c-2',
          displayName: 'Other',
          email: 'o@example.com',
          internal: true,
          mergedIntoCandidateId: null,
        },
        {
          id: 'c-3',
          displayName: 'Old',
          email: null,
          internal: false,
          mergedIntoCandidateId: 'c-2',
        },
      ],
    });
    const page = await candidateSource('org-1', { excludeId: 'c-1' }).search('o', null);
    expect(mocks.recruitmentApi.candidates).toHaveBeenCalledWith('org-1', { search: 'o' });
    expect(page.items).toEqual([
      { id: 'c-2', label: 'Other', description: 'o@example.com · Internal' },
      { id: 'c-3', label: 'Old', disabledReason: 'Merged' },
    ]);
    expect(page.next).toBeNull();
  });

  it('loads a short list once, filters it as the user types, and retries after a failure', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([
        { id: 'd-1', label: 'Finance' },
        { id: 'd-2', label: 'Operations', description: 'OPS' },
      ]);
    const source = listSource(load);
    await expect(source.search('', null)).rejects.toThrow('offline');
    expect((await source.search('', null)).items).toHaveLength(2);
    expect((await source.search('ops', null)).items.map((item) => item.id)).toEqual(['d-2']);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
