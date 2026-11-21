import { beforeEach, describe, expect, it, vi } from 'vitest';
import { employeeApi } from './api';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../auth/api-client', () => ({ apiRequest }));

describe('employeeApi', () => {
  beforeEach(() => {
    apiRequest.mockClear();
  });

  it('serializes supported directory filters and cursor', async () => {
    apiRequest.mockResolvedValue({ items: [], nextAfterId: null });
    await employeeApi.list({
      search: 'Ada Lovelace',
      status: 'ACTIVE',
      organizationId: 'org/1',
      jobTitleId: 'job title',
      limit: 25,
      afterId: 'employee-1',
    });
    expect(apiRequest).toHaveBeenCalledWith(
      '/employees?search=Ada+Lovelace&status=ACTIVE&organizationId=org%2F1&jobTitleId=job+title&limit=25&afterId=employee-1',
    );
  });

  it('encodes Employee IDs and omits empty query values', async () => {
    apiRequest.mockClear();
    apiRequest.mockResolvedValue({});
    await employeeApi.list({ search: '', afterId: undefined });
    await employeeApi.get('employee/1');
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/employees');
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/employees/employee%2F1');
  });

  it('creates employees with the exact payload provided', async () => {
    apiRequest.mockResolvedValue({ id: 'employee-1' });
    const input = {
      person: { firstName: 'Ada', lastName: 'Lovelace' },
      hireDate: '2026-10-02',
      initialPositionId: 'position-1',
      initialEmploymentType: 'FULL_TIME' as const,
      initialStartDate: '2026-10-02',
      initialPrimary: true,
    };

    await employeeApi.create(input);

    expect(apiRequest).toHaveBeenCalledWith('/employees', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  });

  it('updates employee profile fields with an encoded Employee ID', async () => {
    apiRequest.mockResolvedValue({ id: 'employee-1' });
    const input = { firstName: 'Ada', phone: '555-0100' };

    await employeeApi.update('employee/1', input);

    expect(apiRequest).toHaveBeenCalledWith('/employees/employee%2F1', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  });

  it('lists person and position options with encoded search, limit, cursor, and organization', async () => {
    apiRequest.mockResolvedValue({ items: [], nextAfterId: null });

    await employeeApi.listPersonOptions({ search: 'Ada Lovelace', limit: 10, afterId: 'person/1' });
    await employeeApi.listPositionOptions({
      search: 'Platform Engineer',
      limit: 20,
      afterId: 'position/1',
      organizationId: 'org/1',
    });
    await employeeApi.listPersonOptions({ search: '', afterId: undefined });

    expect(apiRequest).toHaveBeenNthCalledWith(
      1,
      '/employees/options/people?search=Ada+Lovelace&limit=10&afterId=person%2F1',
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      '/employees/options/positions?search=Platform+Engineer&limit=20&afterId=position%2F1&organizationId=org%2F1',
    );
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/employees/options/people');
  });

  it('lists manager assignment options with encoded subordinate, search, limit, and cursor', async () => {
    apiRequest.mockResolvedValue({ items: [], nextAfterId: null });

    await employeeApi.listManagerAssignmentOptions({
      subordinateAssignmentId: 'assignment/1',
      search: 'Grace Hopper',
      limit: 10,
      afterId: 'manager/1',
    });

    expect(apiRequest).toHaveBeenCalledWith(
      '/employees/options/manager-assignments?subordinateAssignmentId=assignment%2F1&search=Grace+Hopper&limit=10&afterId=manager%2F1',
    );
  });

  it('calls assignment mutation routes with encoded IDs and exact bodies', async () => {
    apiRequest.mockResolvedValue({ id: 'assignment-1' });

    await employeeApi.createAssignment('employee/1', {
      positionId: 'position-1',
      employmentType: 'FULL_TIME',
      startDate: '2026-10-02',
      isPrimary: false,
    });
    await employeeApi.updateAssignment('employee/1', 'assignment/1', {
      employmentType: 'PART_TIME',
      startDate: '2026-10-03',
      endDate: '2026-12-31',
    });
    await employeeApi.endAssignment('employee/1', 'assignment/1', { endDate: '2026-12-31' });
    await employeeApi.cancelAssignment('employee/1', 'assignment/1');
    await employeeApi.setAssignmentPrimary('employee/1', 'assignment/1', { isPrimary: true });
    await employeeApi.setAssignmentManager('employee/1', 'assignment/1', {
      managerAssignmentId: 'manager-1',
    });
    await employeeApi.setAssignmentManager('employee/1', 'assignment/1', {
      managerAssignmentId: null,
    });
    await employeeApi.terminate('employee/1', { terminationDate: '2026-12-31' });
    await employeeApi.rehire('employee/1', {
      assignment: {
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: '2027-01-15',
      },
    });

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/employees/employee%2F1/assignments', {
      method: 'POST',
      body: JSON.stringify({
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: '2026-10-02',
        isPrimary: false,
      }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      '/employees/employee%2F1/assignments/assignment%2F1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          employmentType: 'PART_TIME',
          startDate: '2026-10-03',
          endDate: '2026-12-31',
        }),
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      3,
      '/employees/employee%2F1/assignments/assignment%2F1/end',
      {
        method: 'POST',
        body: JSON.stringify({ endDate: '2026-12-31' }),
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      4,
      '/employees/employee%2F1/assignments/assignment%2F1/cancel',
      {
        method: 'POST',
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      5,
      '/employees/employee%2F1/assignments/assignment%2F1/primary',
      {
        method: 'PATCH',
        body: JSON.stringify({ isPrimary: true }),
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      6,
      '/employees/employee%2F1/assignments/assignment%2F1/manager',
      {
        method: 'PATCH',
        body: JSON.stringify({ managerAssignmentId: 'manager-1' }),
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      7,
      '/employees/employee%2F1/assignments/assignment%2F1/manager',
      {
        method: 'PATCH',
        body: JSON.stringify({ managerAssignmentId: null }),
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(8, '/employees/employee%2F1/terminate', {
      method: 'POST',
      body: JSON.stringify({ terminationDate: '2026-12-31' }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(9, '/employees/employee%2F1/rehire', {
      method: 'POST',
      body: JSON.stringify({
        assignment: {
          positionId: 'position-1',
          employmentType: 'FULL_TIME',
          startDate: '2027-01-15',
        },
      }),
    });
    expect(employeeApi).not.toHaveProperty('disableUser');
    expect(employeeApi).not.toHaveProperty('removeRoles');
  });
});
