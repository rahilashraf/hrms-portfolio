import { BadRequestException } from '@nestjs/common';
import {
  AUDIT_MAX_LIMIT,
  auditLimit,
  decodeAuditCursor,
  encodeAuditCursor,
  projectAuditMetadata,
  resolveAuditRange,
} from './audit-viewer-domain.js';

const ID = '7c0e3f8e-3f63-4a51-9a52-0f1ab3a5c001';

describe('audit viewer domain (Phase 19)', () => {
  it('projects only whitelisted keys with identifier / enum / field-name / date / number / boolean values', () => {
    expect(
      projectAuditMetadata({
        organizationId: ID,
        employeeId: ID,
        status: 'APPROVED',
        fields: ['firstName', 'personalEmail'],
        key: 'documents.selfServiceProvide',
        versionNumber: 3,
        withReason: true,
        from: '2027-01-01',
        // Not whitelisted: never shown whatever they contain.
        reason: 'Sick child at home',
        note: 'Private',
        email: 'person@example.com',
        before: { rateAmount: '23.0000' },
        storageKey: 'bucket/key.pdf',
        amount: '120.00',
      }),
    ).toEqual({
      organizationId: ID,
      employeeId: ID,
      status: 'APPROVED',
      fields: ['firstName', 'personalEmail'],
      key: 'documents.selfServiceProvide',
      versionNumber: 3,
      withReason: true,
      from: '2027-01-01',
    });
  });

  it('drops free text even under a whitelisted key', () => {
    expect(
      projectAuditMetadata({
        status: 'Approved after a call with the doctor',
        source: 'https://example.com/cv.pdf',
        fields: ['ok', 'not a field name'],
        type: { nested: 'object' },
        kind: Number.NaN,
      }),
    ).toEqual({});
    expect(projectAuditMetadata(null)).toEqual({});
    expect(projectAuditMetadata(['array'])).toEqual({});
  });

  it('round-trips the keyset cursor and refuses tampered ones', () => {
    const cursor = { occurredAt: new Date('2027-01-02T03:04:05.678Z'), id: ID };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    for (const bad of [
      'garbage',
      Buffer.from('2027-01-01T00:00:00Z|not-a-uuid').toString('base64url'),
      Buffer.from(`nope|${ID}`).toString('base64url'),
      Buffer.from(`2027-01-01T00:00:00Z|${ID}|x`).toString('base64url'),
    ])
      expect(() => decodeAuditCursor(bad)).toThrow(BadRequestException);
  });

  it('defaults to the last 30 days and caps the window at 366 days', () => {
    const now = new Date('2027-06-01T00:00:00.000Z');
    expect(resolveAuditRange({}, now)).toEqual({
      from: new Date('2027-05-02T00:00:00.000Z'),
      to: now,
    });
    expect(() =>
      resolveAuditRange(
        { from: '2025-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' },
        now,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveAuditRange(
        { from: '2027-02-01T00:00:00Z', to: '2027-01-01T00:00:00Z' },
        now,
      ),
    ).toThrow(BadRequestException);
    expect(auditLimit(undefined)).toBe(50);
    expect(auditLimit(10_000)).toBe(AUDIT_MAX_LIMIT);
    expect(auditLimit(0)).toBe(1);
  });
});
