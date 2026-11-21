import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  OrganizationCreateDto,
  OrganizationUpdateDto,
  PositionCreateDto,
  TeamCreateDto,
  WorkLocationCreateDto,
} from './organization.dto.js';

describe('organization DTO validation', () => {
  it.each([
    ['finance', 'FINANCE'],
    ['  Weekend   School ', 'WEEKEND-SCHOOL'],
  ])('normalizes code %s to %s', async (code, normalized) => {
    const dto = plainToInstance(OrganizationCreateDto, {
      code,
      name: 'Example',
    });

    expect(dto.code).toBe(normalized);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each(['', 'A', 'a/b', '###'])('rejects invalid code %s', async (code) => {
    const dto = plainToInstance(OrganizationCreateDto, {
      code,
      name: 'Example',
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects code mutation on update DTOs', async () => {
    const dto = plainToInstance(OrganizationUpdateDto, {
      name: 'Renamed',
      code: 'NEW-CODE',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toContain('code');
  });

  it('rejects Teams with both placement anchors at DTO validation', async () => {
    const dto = plainToInstance(TeamCreateDto, {
      code: 'OPS',
      name: 'Operations',
      departmentId: '00000000-0000-0000-0000-000000000002',
      organizationalUnitId: '00000000-0000-0000-0000-000000000003',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.constraints?.teamPlacementXor)).toBe(
      true,
    );
  });

  it('rejects Teams with no placement anchor at DTO validation', async () => {
    const dto = plainToInstance(TeamCreateDto, {
      code: 'OPS',
      name: 'Operations',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.constraints?.teamPlacementXor)).toBe(
      true,
    );
  });

  it('rejects Positions with multiple placement anchors at DTO validation', async () => {
    const dto = plainToInstance(PositionCreateDto, {
      code: 'MANAGER',
      name: 'Manager',
      jobTitleId: '00000000-0000-0000-0000-000000000001',
      departmentId: '00000000-0000-0000-0000-000000000002',
      teamId: '00000000-0000-0000-0000-000000000003',
    });

    const errors = await validate(dto);
    expect(
      errors.some((error) => error.constraints?.positionPlacementLimit),
    ).toBe(true);
  });

  it('rejects invalid IANA time zones', async () => {
    const dto = plainToInstance(WorkLocationCreateDto, {
      code: 'HQ',
      name: 'Headquarters',
      timezone: 'Mars/Olympus_Mons',
    });

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
