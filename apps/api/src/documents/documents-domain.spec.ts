import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  clearanceOf,
  expiryStatus,
  levelWithin,
  parseDocumentCode,
  parseStorageReference,
  readPermissionFor,
  requirementApplies,
  satisfies,
} from './documents-domain.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

function code(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { code: string })
      .code;
  }
  throw new Error('Expected a validation error.');
}

describe('documents domain', () => {
  it('normalizes codes', () => {
    expect(parseDocumentCode(' first-aid ')).toBe('FIRST-AID');
    expect(code(() => parseDocumentCode('!'))).toBe('DOCUMENT_CODE_INVALID');
  });

  it('orders confidentiality levels and maps them to read permissions', () => {
    expect(readPermissionFor('EMPLOYEE_VISIBLE')).toBe('document.read');
    expect(readPermissionFor('MANAGER_VISIBLE')).toBe('document.read');
    expect(readPermissionFor('HR_ONLY')).toBe('document.confidential.read');
    expect(readPermissionFor('RESTRICTED')).toBe('document.restricted.read');
    expect(clearanceOf(new Set())).toBe(-1);
    expect(clearanceOf(new Set(['document.manage']))).toBe(-1);
    const reader = clearanceOf(new Set(['document.read']));
    expect(levelWithin('MANAGER_VISIBLE', reader)).toBe(true);
    expect(levelWithin('HR_ONLY', reader)).toBe(false);
    expect(
      levelWithin(
        'RESTRICTED',
        clearanceOf(new Set(['document.confidential.read'])),
      ),
    ).toBe(false);
    expect(
      levelWithin(
        'RESTRICTED',
        clearanceOf(new Set(['document.restricted.read'])),
      ),
    ).toBe(true);
  });

  it('validates provider-neutral storage references (never contents)', () => {
    expect(
      parseStorageReference({
        provider: 'GOOGLE_DRIVE',
        externalFileId: '1AbC_def',
      }),
    ).toMatchObject({ externalFileId: '1AbC_def', externalUrl: null });
    expect(
      code(() => parseStorageReference({ provider: 'GOOGLE_DRIVE' })),
    ).toBe('DOCUMENT_REFERENCE_REQUIRED');
    expect(
      code(() =>
        parseStorageReference({
          provider: 'EXTERNAL_URL',
          externalUrl: 'http://x.test/a',
        }),
      ),
    ).toBe('DOCUMENT_URL_INVALID');
    expect(
      code(() =>
        parseStorageReference({
          provider: 'EXTERNAL_URL',
          externalUrl: 'javascript:alert(1)',
        }),
      ),
    ).toBe('DOCUMENT_URL_INVALID');
    // Batch 9 (F2): internal storage takes a server-side upload, never a typed key.
    expect(
      code(() =>
        parseStorageReference({ provider: 'INTERNAL_OBJECT_STORAGE' }),
      ),
    ).toBe('DOCUMENT_UPLOAD_REQUIRED');
    for (const storageKey of [
      '../etc/passwd',
      '/abs/key',
      'org-1/emp-2/contract.pdf',
    ])
      expect(
        code(() =>
          parseStorageReference({
            provider: 'INTERNAL_OBJECT_STORAGE',
            storageKey,
          }),
        ),
      ).toBe('DOCUMENT_STORAGE_KEY_NOT_ACCEPTED');
    expect(
      code(() =>
        parseStorageReference({
          provider: 'MANUAL_REFERENCE',
          storageKey: 'a/b',
        }),
      ),
    ).toBe('DOCUMENT_STORAGE_KEY_NOT_ACCEPTED');
    expect(
      parseStorageReference({
        provider: 'INTERNAL_OBJECT_STORAGE',
        uploadId: '11111111-1111-4111-8111-111111111111',
      }).uploadId,
    ).toBe('11111111-1111-4111-8111-111111111111');
    expect(
      code(() =>
        parseStorageReference({
          provider: 'EXTERNAL_URL',
          externalUrl: 'https://x.test/a',
          uploadId: '11111111-1111-4111-8111-111111111111',
        }),
      ),
    ).toBe('DOCUMENT_UPLOAD_INVALID');
    expect(
      parseStorageReference({ provider: 'MANUAL_REFERENCE' }).provider,
    ).toBe('MANUAL_REFERENCE');
    expect(
      code(() =>
        parseStorageReference({ provider: 'MANUAL_REFERENCE', sizeBytes: -1 }),
      ),
    ).toBe('DOCUMENT_SIZE_INVALID');
  });

  it('derives expiry from the date', () => {
    const today = d('2026-03-15');
    expect(expiryStatus(null, today)).toBe('NO_EXPIRY');
    expect(expiryStatus(d('2026-03-14'), today)).toBe('EXPIRED');
    expect(expiryStatus(d('2026-03-15'), today)).toBe('EXPIRING_SOON');
    expect(expiryStatus(d('2026-04-14'), today)).toBe('EXPIRING_SOON');
    expect(expiryStatus(d('2026-04-15'), today)).toBe('VALID');
    expect(
      satisfies({ status: 'ACTIVE', expiresOn: d('2026-03-15') }, today),
    ).toBe(true);
    expect(
      satisfies({ status: 'ACTIVE', expiresOn: d('2026-03-14') }, today),
    ).toBe(false);
    expect(satisfies({ status: 'ARCHIVED', expiresOn: null }, today)).toBe(
      false,
    );
  });

  it('applies simple requirement criteria', () => {
    const assignment = {
      employmentType: 'FULL_TIME',
      positionId: 'p1',
      departmentId: 'd1',
    };
    expect(
      requirementApplies(
        { employmentType: null, departmentId: null, positionId: null },
        assignment,
      ),
    ).toBe(true);
    expect(
      requirementApplies(
        { employmentType: 'FULL_TIME', departmentId: 'd1', positionId: null },
        assignment,
      ),
    ).toBe(true);
    expect(
      requirementApplies(
        { employmentType: 'CASUAL', departmentId: null, positionId: null },
        assignment,
      ),
    ).toBe(false);
    expect(
      requirementApplies(
        { employmentType: null, departmentId: null, positionId: 'p2' },
        assignment,
      ),
    ).toBe(false);
  });
});
