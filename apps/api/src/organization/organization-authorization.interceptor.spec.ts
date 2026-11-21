/* oxlint-disable typescript/unbound-method */
import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { RoleAssignmentScopeType } from '../generated/prisma/enums.js';
import { PrismaService } from '../database/prisma.service.js';
import { OrganizationAuthorizationInterceptor } from './organization-authorization.interceptor.js';

const detailCases = [
  {
    handler: 'getOrganization',
    setup: (prisma: PrismaService) =>
      vi
        .mocked(prisma.organization.findFirst)
        .mockResolvedValue({ id: 'entity-1' } as never),
    scope: { type: RoleAssignmentScopeType.ORGANIZATION, id: 'entity-1' },
  },
  {
    handler: 'getOrganizationalUnit',
    setup: (prisma: PrismaService) =>
      vi
        .mocked(prisma.organizationalUnit.findFirst)
        .mockResolvedValue({ id: 'entity-1' } as never),
    scope: {
      type: RoleAssignmentScopeType.ORGANIZATIONAL_UNIT,
      id: 'entity-1',
    },
  },
  {
    handler: 'getDepartment',
    setup: (prisma: PrismaService) =>
      vi
        .mocked(prisma.department.findFirst)
        .mockResolvedValue({ id: 'entity-1' } as never),
    scope: { type: RoleAssignmentScopeType.DEPARTMENT, id: 'entity-1' },
  },
  {
    handler: 'getTeam',
    setup: (prisma: PrismaService) =>
      vi
        .mocked(prisma.team.findFirst)
        .mockResolvedValue({ id: 'entity-1' } as never),
    scope: { type: RoleAssignmentScopeType.TEAM, id: 'entity-1' },
  },
  {
    handler: 'getJobTitle',
    setup: (prisma: PrismaService) =>
      vi
        .mocked(prisma.jobTitle.findFirst)
        .mockResolvedValue({ id: 'entity-1' } as never),
    scope: { type: RoleAssignmentScopeType.ORGANIZATION, id: 'org-1' },
  },
  {
    handler: 'getPosition',
    setup: (prisma: PrismaService) =>
      vi.mocked(prisma.position.findFirst).mockResolvedValue({
        id: 'entity-1',
        organizationalUnitId: null,
        departmentId: null,
        teamId: null,
      } as never),
    scope: { type: RoleAssignmentScopeType.ORGANIZATION, id: 'org-1' },
  },
  {
    handler: 'getWorkLocation',
    setup: (prisma: PrismaService) =>
      vi
        .mocked(prisma.workLocation.findFirst)
        .mockResolvedValue({ id: 'entity-1' } as never),
    scope: { type: RoleAssignmentScopeType.ORGANIZATION, id: 'org-1' },
  },
] as const;

describe('OrganizationAuthorizationInterceptor', () => {
  const prisma = {
    organization: { findFirst: vi.fn() },
    organizationalUnit: { findFirst: vi.fn() },
    department: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
    jobTitle: { findFirst: vi.fn() },
    position: { findFirst: vi.fn() },
    workLocation: { findFirst: vi.fn() },
  } as unknown as PrismaService;
  const authorization = {
    assertAccess: vi.fn(),
    canAccess: vi.fn(),
  } as unknown as AuthorizationService;
  const interceptor = new OrganizationAuthorizationInterceptor(
    prisma,
    authorization,
  );

  function executionContext(
    handler: string,
    request: Record<string, unknown>,
  ): ExecutionContext {
    return {
      getHandler: () => ({ name: handler }),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function handler(result: unknown): CallHandler {
    return { handle: () => of(result) };
  }

  const authenticatedRequest = {
    auth: { userId: 'user-1', sessionId: 'session-1' },
    params: {},
    body: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorization.assertAccess).mockResolvedValue(undefined);
    vi.mocked(authorization.canAccess).mockResolvedValue(true);
  });

  it('restricts organization creation to SYSTEM-scope manage access', async () => {
    await lastValueFrom(
      interceptor.intercept(
        executionContext('createOrganization', authenticatedRequest),
        handler({ id: 'org-1' }),
      ),
    );

    expect(authorization.assertAccess).toHaveBeenCalledWith(
      'user-1',
      'organization.manage',
      { type: RoleAssignmentScopeType.SYSTEM },
    );
  });

  it.each(detailCases)(
    'allows authorized $handler detail reads at the resolved target scope',
    async ({ handler: method, setup, scope }) => {
      setup(prisma);

      await expect(
        lastValueFrom(
          interceptor.intercept(
            executionContext(method, {
              ...authenticatedRequest,
              params: { organizationId: 'org-1', id: 'entity-1' },
            }),
            handler({ id: 'entity-1' }),
          ),
        ),
      ).resolves.toEqual({ id: 'entity-1' });
      expect(authorization.assertAccess).toHaveBeenCalledWith(
        'user-1',
        'organization.read',
        scope,
      );
    },
  );

  it.each(detailCases)(
    'denies unauthorized $handler detail reads',
    async ({ handler: method, setup }) => {
      setup(prisma);
      vi.mocked(authorization.assertAccess).mockRejectedValue(
        new ForbiddenException(),
      );

      await expect(
        lastValueFrom(
          interceptor.intercept(
            executionContext(method, {
              ...authenticatedRequest,
              params: { organizationId: 'org-1', id: 'entity-1' },
            }),
            handler({ id: 'entity-1' }),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('checks both the Team source and Department destination when moving it', async () => {
    vi.mocked(prisma.team.findFirst).mockResolvedValue({
      id: 'team-1',
    } as never);
    vi.mocked(prisma.department.findFirst).mockResolvedValue({
      id: 'department-2',
    } as never);

    await lastValueFrom(
      interceptor.intercept(
        executionContext('updateTeam', {
          ...authenticatedRequest,
          params: { organizationId: 'org-1', id: 'team-1' },
          body: { departmentId: 'department-2', organizationalUnitId: null },
        }),
        handler({ id: 'team-1' }),
      ),
    );

    expect(authorization.assertAccess).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'organization.manage',
      { type: RoleAssignmentScopeType.TEAM, id: 'team-1' },
    );
    expect(authorization.assertAccess).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'organization.manage',
      { type: RoleAssignmentScopeType.DEPARTMENT, id: 'department-2' },
    );
  });

  it('treats an explicit null Position anchor as organization-level destination', async () => {
    vi.mocked(prisma.position.findFirst)
      .mockResolvedValueOnce({
        id: 'position-1',
        teamId: 'team-1',
        departmentId: null,
        organizationalUnitId: null,
      } as never)
      .mockResolvedValueOnce({
        id: 'position-1',
        teamId: 'team-1',
        departmentId: null,
        organizationalUnitId: null,
      } as never);
    vi.mocked(prisma.team.findFirst).mockResolvedValue({
      id: 'team-1',
    } as never);

    await lastValueFrom(
      interceptor.intercept(
        executionContext('updatePosition', {
          ...authenticatedRequest,
          params: { organizationId: 'org-1', id: 'position-1' },
          body: { teamId: null },
        }),
        handler({ id: 'position-1' }),
      ),
    );

    expect(authorization.assertAccess).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'organization.manage',
      { type: RoleAssignmentScopeType.TEAM, id: 'team-1' },
    );
    expect(authorization.assertAccess).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'organization.manage',
      { type: RoleAssignmentScopeType.ORGANIZATION, id: 'org-1' },
    );
  });

  it('filters inaccessible siblings from collection results', async () => {
    vi.mocked(prisma.department.findFirst)
      .mockResolvedValueOnce({ id: 'department-1' } as never)
      .mockResolvedValueOnce({ id: 'department-2' } as never);
    vi.mocked(authorization.canAccess)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await lastValueFrom(
      interceptor.intercept(
        executionContext('listDepartments', {
          ...authenticatedRequest,
          params: { organizationId: 'org-1' },
        }),
        handler([
          { id: 'department-1', organizationId: 'org-1' },
          { id: 'department-2', organizationId: 'org-1' },
        ]),
      ),
    );

    expect(result).toEqual([{ id: 'department-1', organizationId: 'org-1' }]);
  });

  it('does not reveal an inaccessible parent when a descendant is visible', async () => {
    vi.mocked(authorization.canAccess)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await lastValueFrom(
      interceptor.intercept(
        executionContext('getStructure', {
          ...authenticatedRequest,
          params: { organizationId: 'org-1' },
        }),
        handler([
          {
            id: 'unit-parent',
            name: 'Parent',
            children: [{ id: 'unit-child', name: 'Child', children: [] }],
          },
        ]),
      ),
    );

    expect(result).toEqual([{ id: 'unit-child', name: 'Child', children: [] }]);
  });

  it('denies creation when an anchor is outside the route organization', async () => {
    vi.mocked(prisma.department.findFirst).mockResolvedValue(null);

    await expect(
      lastValueFrom(
        interceptor.intercept(
          executionContext('createTeam', {
            ...authenticatedRequest,
            params: { organizationId: 'org-1' },
            body: {
              departmentId: 'department-other',
              organizationalUnitId: null,
            },
          }),
          handler({ id: 'team-1' }),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorization.assertAccess).not.toHaveBeenCalled();
  });

  it('passes position reference options through unfiltered for the service to authorize', async () => {
    const options = {
      jobTitles: [{ id: 'jt-1', name: 'Analyst', code: 'AN' }],
      workLocations: [],
    };

    await expect(
      lastValueFrom(
        interceptor.intercept(
          executionContext('positionReferenceOptions', {
            ...authenticatedRequest,
            params: { organizationId: 'org-1' },
          }),
          handler(options),
        ),
      ),
    ).resolves.toEqual(options);
    // Not treated as a resource list: no organization.read row filter, no ORGANIZATION check.
    expect(authorization.assertAccess).not.toHaveBeenCalled();
    expect(authorization.canAccess).not.toHaveBeenCalled();
    expect(prisma.jobTitle.findFirst).not.toHaveBeenCalled();
  });

  it('still requires an authenticated user for position reference options', () => {
    expect(() =>
      interceptor.intercept(
        executionContext('positionReferenceOptions', {
          params: { organizationId: 'org-1' },
          body: {},
        }),
        handler({}),
      ),
    ).toThrow('Unauthorized');
  });

  it('keeps Job Title and Work Location creation organization-level', async () => {
    for (const method of ['createJobTitle', 'createWorkLocation']) {
      vi.mocked(authorization.assertAccess).mockClear();
      await lastValueFrom(
        interceptor.intercept(
          executionContext(method, {
            ...authenticatedRequest,
            params: { organizationId: 'org-1' },
            body: { name: 'X', code: 'X' },
          }),
          handler({ id: 'x' }),
        ),
      );
      expect(authorization.assertAccess).toHaveBeenCalledWith(
        'user-1',
        'organization.manage',
        { type: RoleAssignmentScopeType.ORGANIZATION, id: 'org-1' },
      );
    }
  });
});
