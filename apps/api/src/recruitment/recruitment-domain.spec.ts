import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  canMoveApplication,
  canMoveOffer,
  canMoveOpening,
  defaultFeedbackDue,
  effectiveOfferStatus,
  initialStage,
  normalizeCandidateEmail,
  normalizeSubmission,
  offerIsExpired,
  openingAfterCountChange,
  openingAfterHire,
  parseDocumentReference,
  parseDuration,
  parseHttpsUrl,
  parseInstant,
  parseRating,
  parseRecruitmentCode,
  submissionHash,
} from './recruitment-domain.js';

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

describe('recruitment domain', () => {
  it('normalizes codes and refuses malformed ones', () => {
    expect(parseRecruitmentCode(' req-2026-014 ')).toBe('REQ-2026-014');
    expect(code(() => parseRecruitmentCode('a'))).toBe(
      'RECRUITMENT_CODE_INVALID',
    );
    expect(code(() => parseRecruitmentCode('has space'))).toBe(
      'RECRUITMENT_CODE_INVALID',
    );
  });

  it('deduplicates by normalized email only, refusing malformed addresses', () => {
    expect(normalizeCandidateEmail('  Ada.Lovelace@Example.COM ')).toBe(
      'ada.lovelace@example.com',
    );
    expect(normalizeCandidateEmail('')).toBeNull();
    expect(normalizeCandidateEmail(null)).toBeNull();
    expect(code(() => normalizeCandidateEmail('not-an-email'))).toBe(
      'RECRUITMENT_EMAIL_INVALID',
    );
  });

  it('accepts https links only', () => {
    expect(parseHttpsUrl('https://drive.google.com/file/d/abc', 'url')).toBe(
      'https://drive.google.com/file/d/abc',
    );
    expect(parseHttpsUrl('', 'url')).toBeNull();
    for (const bad of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://x',
    ]) {
      expect(code(() => parseHttpsUrl(bad, 'url'))).toBe(
        'RECRUITMENT_URL_INVALID',
      );
    }
  });

  it('parses ISO instants strictly', () => {
    expect(parseInstant('2026-09-01T14:30:00Z', 'at')?.toISOString()).toBe(
      '2026-09-01T14:30:00.000Z',
    );
    expect(parseInstant(null, 'at')).toBeNull();
    expect(code(() => parseInstant('yesterday', 'at'))).toBe(
      'RECRUITMENT_DATE_INVALID',
    );
    expect(code(() => parseInstant(12, 'at'))).toBe('RECRUITMENT_DATE_INVALID');
  });

  it('mirrors the opening lifecycle of the database guard', () => {
    expect(canMoveOpening('DRAFT', 'OPEN')).toBe(true);
    expect(canMoveOpening('DRAFT', 'ON_HOLD')).toBe(false);
    expect(canMoveOpening('OPEN', 'FILLED')).toBe(true);
    expect(canMoveOpening('FILLED', 'OPEN')).toBe(true);
    expect(canMoveOpening('FILLED', 'CANCELLED')).toBe(false);
    expect(canMoveOpening('CLOSED', 'OPEN')).toBe(false);
    expect(canMoveOpening('CANCELLED', 'OPEN')).toBe(false);
  });

  it('mirrors the application and offer lifecycles', () => {
    expect(canMoveApplication('ACTIVE', 'OFFERED')).toBe(true);
    expect(canMoveApplication('ACTIVE', 'HIRED')).toBe(false);
    expect(canMoveApplication('OFFERED', 'HIRED')).toBe(true);
    expect(canMoveApplication('REJECTED', 'ACTIVE')).toBe(false);
    expect(canMoveApplication('HIRED', 'WITHDRAWN')).toBe(false);
    expect(canMoveOffer('DRAFT', 'SENT')).toBe(false);
    expect(canMoveOffer('APPROVED', 'DRAFT')).toBe(true);
    expect(canMoveOffer('SENT', 'ACCEPTED')).toBe(true);
    expect(canMoveOffer('ACCEPTED', 'WITHDRAWN')).toBe(false);
    expect(canMoveOffer('EXPIRED', 'ACCEPTED')).toBe(false);
  });

  it('derives offer expiry from the date (no job needed)', () => {
    const sent = { status: 'SENT' as const, expiresOn: d('2026-03-10') };
    expect(offerIsExpired(sent, d('2026-03-10'))).toBe(false);
    expect(offerIsExpired(sent, d('2026-03-11'))).toBe(true);
    expect(effectiveOfferStatus(sent, d('2026-03-11'))).toBe('EXPIRED');
    expect(
      offerIsExpired({ status: 'SENT', expiresOn: null }, d('2030-01-01')),
    ).toBe(false);
    expect(
      offerIsExpired(
        { status: 'ACCEPTED', expiresOn: d('2026-01-01') },
        d('2026-03-11'),
      ),
    ).toBe(false);
    expect(
      offerIsExpired({ status: 'EXPIRED', expiresOn: null }, d('2026-01-01')),
    ).toBe(true);
  });

  it('fills an opening with its last hire and reopens it when openings grow', () => {
    expect(
      openingAfterHire({ status: 'OPEN', openingCount: 2, hiredCount: 0 }),
    ).toEqual({ hiredCount: 1, status: 'OPEN' });
    expect(
      openingAfterHire({ status: 'OPEN', openingCount: 2, hiredCount: 1 }),
    ).toEqual({ hiredCount: 2, status: 'FILLED' });
    expect(
      openingAfterCountChange({ status: 'FILLED', hiredCount: 2 }, 3),
    ).toBe('OPEN');
    expect(openingAfterCountChange({ status: 'OPEN', hiredCount: 2 }, 2)).toBe(
      'FILLED',
    );
    expect(
      openingAfterCountChange({ status: 'ON_HOLD', hiredCount: 0 }, 5),
    ).toBe('ON_HOLD');
    expect(
      code(() => openingAfterCountChange({ status: 'OPEN', hiredCount: 2 }, 1)),
    ).toBe('RECRUITMENT_OPENING_COUNT_BELOW_HIRES');
    expect(
      code(() => openingAfterCountChange({ status: 'OPEN', hiredCount: 0 }, 0)),
    ).toBe('RECRUITMENT_OPENING_COUNT_INVALID');
  });

  it('starts applications in the first live APPLIED stage', () => {
    const stage = (
      id: string,
      kind: 'APPLIED' | 'SCREENING',
      sortOrder: number,
      archived = false,
    ) => ({
      id,
      kind,
      sortOrder,
      archivedAt: archived ? new Date() : null,
    });
    expect(
      initialStage([stage('s', 'SCREENING', 5), stage('a', 'APPLIED', 10)])?.id,
    ).toBe('a');
    expect(
      initialStage([stage('a', 'APPLIED', 1, true), stage('s', 'SCREENING', 5)])
        ?.id,
    ).toBe('s');
    expect(initialStage([])).toBeNull();
  });

  it('validates interview durations, ratings and default feedback due dates', () => {
    expect(parseDuration(45)).toBe(45);
    expect(code(() => parseDuration(2))).toBe(
      'RECRUITMENT_INTERVIEW_DURATION_INVALID',
    );
    expect(code(() => parseDuration(30.5))).toBe(
      'RECRUITMENT_INTERVIEW_DURATION_INVALID',
    );
    expect(parseRating(null)).toBeNull();
    expect(parseRating(5)).toBe(5);
    expect(code(() => parseRating(6))).toBe('RECRUITMENT_RATING_INVALID');
    expect(
      defaultFeedbackDue(new Date('2026-03-10T15:00:00Z'), 60).toISOString(),
    ).toBe('2026-03-11T16:00:00.000Z');
  });

  it('keeps document references (never files) and requires a link where the provider needs one', () => {
    expect(
      parseDocumentReference({
        kind: 'RESUME',
        title: ' CV ',
        provider: 'GOOGLE_DRIVE',
        externalFileId: '1AbC',
      }),
    ).toMatchObject({ title: 'CV', externalFileId: '1AbC', externalUrl: null });
    expect(
      code(() =>
        parseDocumentReference({
          kind: 'RESUME',
          title: 'CV',
          provider: 'EXTERNAL_URL',
        }),
      ),
    ).toBe('RECRUITMENT_DOCUMENT_LINK_REQUIRED');
    expect(
      code(() =>
        parseDocumentReference({
          kind: 'RESUME',
          title: 'CV',
          provider: 'GOOGLE_DRIVE',
        }),
      ),
    ).toBe('RECRUITMENT_DOCUMENT_LINK_REQUIRED');
    expect(
      parseDocumentReference({
        kind: 'REFERENCE',
        title: 'Letter on file',
        provider: 'MANUAL_REFERENCE',
      }).provider,
    ).toBe('MANUAL_REFERENCE');
    expect(
      code(() =>
        parseDocumentReference({
          kind: 'RESUME',
          title: 'CV',
          provider: 'EXTERNAL_URL',
          externalUrl: 'https://x.test/cv',
          mimeType: 'not a type',
        }),
      ),
    ).toBe('RECRUITMENT_DOCUMENT_MIME_INVALID');
  });

  it('normalizes external submissions and hashes their content deterministically', () => {
    const input = {
      openingCode: 'req-1',
      candidate: {
        firstName: ' Ada ',
        lastName: 'Lovelace',
        email: 'ADA@Example.com ',
      },
      answers: [
        { question: 'Teaching certificate?', answer: 'Yes' },
        { question: 'Skipped question', answer: '   ' },
      ],
    };
    const normalized = normalizeSubmission(input);
    expect(normalized).toMatchObject({
      openingCode: 'REQ-1',
      candidate: { firstName: 'Ada', email: 'ada@example.com' },
      answers: [{ question: 'Teaching certificate?', answer: 'Yes' }],
    });
    const at = new Date('2026-09-01T12:00:00Z');
    expect(submissionHash(normalized, at)).toBe(
      submissionHash(normalizeSubmission(input), at),
    );
    expect(submissionHash(normalized, at)).not.toBe(
      submissionHash(
        normalizeSubmission({
          ...input,
          answers: [{ question: 'Teaching certificate?', answer: 'No' }],
        }),
        at,
      ),
    );
    expect(
      code(() =>
        normalizeSubmission({ candidate: { firstName: '', lastName: 'X' } }),
      ),
    ).toBe('RECRUITMENT_TEXT_REQUIRED');
    expect(
      code(() =>
        normalizeSubmission({
          candidate: { firstName: 'A', lastName: 'B' },
          answers: Array.from({ length: 61 }, () => ({
            question: 'q',
            answer: 'a',
          })),
        }),
      ),
    ).toBe('RECRUITMENT_SUBMISSION_INVALID');
  });
});
