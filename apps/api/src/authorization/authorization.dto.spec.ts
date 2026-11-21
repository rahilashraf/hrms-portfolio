import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  RoleAssignmentCreateDto,
  RoleCreateDto,
  RoleUpdateDto,
} from './authorization.dto.js';

describe('authorization DTOs', () => {
  it('normalizes Role codes to uppercase canonical form before validation', () => {
    const role = plainToInstance(RoleCreateDto, {
      code: '  people operations ',
      name: 'People Operations',
      permissionKeys: [],
    });

    expect(role.code).toBe('PEOPLE-OPERATIONS');
    expect(validateSync(role)).toEqual([]);
  });

  it('rejects SYSTEM scope through normal assignment DTOs', () => {
    const assignment = plainToInstance(RoleAssignmentCreateDto, {
      userId: '00000000-0000-0000-0000-000000000001',
      roleId: '00000000-0000-0000-0000-000000000002',
      scope: {
        type: 'SYSTEM',
        id: '00000000-0000-0000-0000-000000000003',
      },
    });

    expect(
      validateSync(assignment).some((error) => error.property === 'scope'),
    ).toBe(true);
  });

  it('does not permit permission changes through metadata updates', () => {
    const role = plainToInstance(RoleUpdateDto, {
      name: 'Reader',
      permissionKeys: ['organization.manage'],
    });

    expect(
      validateSync(role, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }).some(
        (error) =>
          error.property === 'permissionKeys' &&
          error.constraints?.whitelistValidation,
      ),
    ).toBe(true);
  });
});
