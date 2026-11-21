import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AuditActorQueryDto, AuditQueryDto } from './audit-viewer.dto.js';

const errors = (input: Record<string, unknown>) =>
  validateSync(plainToInstance(AuditQueryDto, input)).map(
    (error) => error.property,
  );

describe('AuditQueryDto', () => {
  it('needs an organization for the organization view (the default)', () => {
    expect(errors({})).toEqual(['organizationId']);
    expect(errors({ scope: 'organization' })).toEqual(['organizationId']);
    expect(
      errors({ organizationId: '00000000-0000-4000-8000-000000000001' }),
    ).toEqual([]);
  });

  it('takes the System view without an organization and refuses unknown scopes', () => {
    expect(errors({ scope: 'system' })).toEqual([]);
    expect(errors({ scope: 'everything' })).toEqual([
      'scope',
      'organizationId',
    ]);
  });
});

describe('AuditActorQueryDto (Batch R3.3)', () => {
  const actorErrors = (input: Record<string, unknown>) =>
    validateSync(plainToInstance(AuditActorQueryDto, input)).map(
      (error) => error.property,
    );
  const org = '00000000-0000-4000-8000-000000000001';

  it('needs an organization unless it is the System view', () => {
    expect(actorErrors({})).toEqual(['organizationId']);
    expect(actorErrors({ organizationId: org })).toEqual([]);
    expect(actorErrors({ scope: 'system' })).toEqual([]);
  });

  it('bounds the search text, the page size and the cursor', () => {
    expect(
      actorErrors({ organizationId: org, query: 'a'.repeat(100) }),
    ).toEqual([]);
    expect(
      actorErrors({ organizationId: org, query: 'a'.repeat(101) }),
    ).toEqual(['query']);
    expect(actorErrors({ organizationId: org, limit: '50' })).toEqual([]);
    expect(actorErrors({ organizationId: org, limit: '51' })).toEqual([
      'limit',
    ]);
    expect(actorErrors({ organizationId: org, limit: '0' })).toEqual(['limit']);
    expect(actorErrors({ organizationId: org, afterId: 'x' })).toEqual([
      'afterId',
    ]);
    expect(actorErrors({ organizationId: org, from: 'yesterday' })).toEqual([
      'from',
    ]);
  });
});
