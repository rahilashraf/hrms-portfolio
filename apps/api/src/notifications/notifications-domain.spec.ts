import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  backoffMs,
  BACKOFF_CAP_MS,
  decodeCursor,
  encodeCursor,
  escapeValue,
  formatInstant,
  isMandatory,
  listTitles,
  MAX_EMAIL_ATTEMPTS,
  NOTIFICATION_TYPES,
  placeholdersOf,
  renderTemplate,
  resolveEmailDelivery,
  safeErrorCode,
  safeErrorMessage,
  validateDedupeKey,
  validateLink,
  validateTemplateText,
  containsLink,
} from './notifications-domain.js';
import {
  classifyTransportError,
  DevNotificationEmailTransport,
  NotificationTransportError,
} from './notification-email.transport.js';

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { getResponse(): { code: string } }).getResponse().code;
  }
  throw new Error('Expected a rejection.');
};

describe('notification templates', () => {
  it('parses placeholders and refuses malformed braces', () => {
    expect(placeholdersOf('Hi {{ name }}, {{count}} due', 'x')).toEqual([
      'name',
      'count',
    ]);
    expect(code(() => placeholdersOf('Hi {{name}', 'x'))).toBe(
      'NOTIFICATION_TEMPLATE_SYNTAX',
    );
    expect(code(() => placeholdersOf('Hi {name}', 'x'))).toBe(
      'NOTIFICATION_TEMPLATE_SYNTAX',
    );
    expect(code(() => placeholdersOf('Hi {{1abc}}', 'x'))).toBe(
      'NOTIFICATION_TEMPLATE_SYNTAX',
    );
  });

  it('validates template text: allowed placeholders only, bounded, no links', () => {
    expect(
      validateTemplateText(' Tasks due ', ' You have {{count}} tasks. ', [
        'count',
      ]),
    ).toEqual({
      subjectTemplate: 'Tasks due',
      bodyTemplate: 'You have {{count}} tasks.',
    });
    expect(
      code(() =>
        validateTemplateText('Tasks', 'Hello {{candidateEmail}}', ['count']),
      ),
    ).toBe('NOTIFICATION_TEMPLATE_PLACEHOLDER');
    expect(
      code(() =>
        validateTemplateText('Tasks', 'See https://evil.example.com', []),
      ),
    ).toBe('NOTIFICATION_TEMPLATE_LINK');
    expect(
      code(() => validateTemplateText('Tasks', 'Visit www.example.com', [])),
    ).toBe('NOTIFICATION_TEMPLATE_LINK');
    expect(code(() => validateTemplateText('', 'Body', []))).toBe(
      'NOTIFICATION_TEMPLATE_INVALID',
    );
    expect(code(() => validateTemplateText('x'.repeat(201), 'Body', []))).toBe(
      'NOTIFICATION_TEMPLATE_INVALID',
    );
    expect(code(() => validateTemplateText('Subject', 'a\u0007b', []))).toBe(
      'NOTIFICATION_TEMPLATE_INVALID',
    );
  });

  it('renders single-pass with escaped, whitelisted values', () => {
    expect(
      renderTemplate(
        'Hi {{name}}: {{count}} {{secret}}',
        {
          name: 'Ada {{count}}\n<b>Lovelace</b>',
          count: 3,
          secret: 'leak',
        },
        ['name', 'count'],
        200,
      ),
    ).toBe('Hi Ada count <b>Lovelace</b>: 3');
    expect(escapeValue('a b\u0000c  d')).toBe('a b c d');
    expect(escapeValue('x'.repeat(400))).toHaveLength(300);
    expect(
      renderTemplate('{{a}}', { a: 'y'.repeat(250) }, ['a'], 200),
    ).toHaveLength(200);
    expect(escapeValue(new Date('2026-03-15T16:00:00Z'))).toBe(
      '2026-03-15T16:00:00.000Z',
    );
  });

  it('defines every system template with only allowed placeholders and samples', () => {
    const keys = NOTIFICATION_TYPES.map((type) => type.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const type of NOTIFICATION_TYPES) {
      expect(() =>
        validateTemplateText(
          type.subjectTemplate,
          type.bodyTemplate,
          type.allowedVariables,
        ),
      ).not.toThrow();
      expect(Object.keys(type.sample).sort()).toEqual(
        [...type.allowedVariables].sort(),
      );
      expect(type.key).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
      if (type.category === 'HR_REQUIRED' || type.category === 'SECURITY')
        expect(type.mandatory).toBe(true);
    }
  });
});

describe('notification links and keys', () => {
  it('accepts relative application paths only', () => {
    expect(validateLink('/onboarding')).toBe('/onboarding');
    expect(validateLink('/recruitment/applications/abc-123?tab=offers')).toBe(
      '/recruitment/applications/abc-123?tab=offers',
    );
    expect(validateLink(null)).toBeNull();
    for (const bad of [
      'https://evil.example.com',
      '//evil.example.com/x',
      'javascript:alert(1)',
      'onboarding',
      '/a/../admin',
      '/a\\b',
      '/x y',
      `/${'a'.repeat(300)}`,
    ]) {
      expect(
        code(() => validateLink(bad)),
        bad,
      ).toBe('NOTIFICATION_LINK_INVALID');
    }
  });

  it('validates dedupe keys', () => {
    expect(validateDedupeKey('onboarding.tasks-due:2026-03-15')).toBe(
      'onboarding.tasks-due:2026-03-15',
    );
    expect(code(() => validateDedupeKey(''))).toBe(
      'NOTIFICATION_DEDUPE_INVALID',
    );
    expect(code(() => validateDedupeKey('a b'))).toBe(
      'NOTIFICATION_DEDUPE_INVALID',
    );
  });

  it('round-trips cursors and refuses forged ones', () => {
    const row = {
      createdAt: new Date('2026-03-15T16:00:00.000Z'),
      id: '00000000-0000-4000-8000-000000000001',
    };
    expect(decodeCursor(encodeCursor(row))).toEqual(row);
    expect(decodeCursor(undefined)).toBeNull();
    expect(code(() => decodeCursor('bm9wZQ'))).toBe(
      'NOTIFICATION_CURSOR_INVALID',
    );
  });
});

describe('email delivery resolution', () => {
  it('lets preferences and organization settings suppress non-mandatory email', () => {
    expect(
      resolveEmailDelivery({ category: 'ONBOARDING', mandatory: false }),
    ).toEqual({ deliver: true });
    expect(
      resolveEmailDelivery({
        category: 'ONBOARDING',
        mandatory: false,
        userEmailEnabled: false,
      }),
    ).toEqual({ deliver: false, reason: 'USER_PREFERENCE' });
    expect(
      resolveEmailDelivery({
        category: 'ONBOARDING',
        mandatory: false,
        userEmailEnabled: true,
        organizationCategoryEmailEnabled: false,
      }),
    ).toEqual({ deliver: false, reason: 'ORGANIZATION_CATEGORY_DISABLED' });
    expect(
      resolveEmailDelivery({
        category: 'ONBOARDING',
        mandatory: false,
        organizationPolicy: {
          emailEnabled: false,
          suppressMandatoryEmail: false,
        },
      }),
    ).toEqual({ deliver: false, reason: 'ORGANIZATION_EMAIL_DISABLED' });
  });

  it('always delivers mandatory notices unless explicitly suppressed with email off', () => {
    for (const input of [
      { category: 'HR_REQUIRED' as const, mandatory: false },
      { category: 'SECURITY' as const, mandatory: false },
      { category: 'DOCUMENTS' as const, mandatory: true },
    ]) {
      expect(isMandatory(input.category, input.mandatory)).toBe(true);
      expect(
        resolveEmailDelivery({
          ...input,
          userEmailEnabled: false,
          organizationCategoryEmailEnabled: false,
          organizationPolicy: {
            emailEnabled: false,
            suppressMandatoryEmail: false,
          },
        }),
      ).toEqual({ deliver: true });
      expect(
        resolveEmailDelivery({
          ...input,
          organizationPolicy: {
            emailEnabled: false,
            suppressMandatoryEmail: true,
          },
        }),
      ).toEqual({ deliver: false, reason: 'ORGANIZATION_EMAIL_DISABLED' });
    }
  });
});

describe('delivery retries', () => {
  it('backs off exponentially, capped, and fails after the maximum attempts', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([
      60_000, 120_000, 240_000, 480_000,
    ]);
    expect(backoffMs(30)).toBe(BACKOFF_CAP_MS);
    const now = new Date('2026-03-15T16:00:00.000Z');
    expect(afterFailure(1, true, now)).toEqual({
      status: 'PENDING',
      nextAttemptAt: new Date('2026-03-15T16:01:00.000Z'),
    });
    expect(afterFailure(MAX_EMAIL_ATTEMPTS, true, now)).toEqual({
      status: 'FAILED',
    });
    expect(afterFailure(1, false, now)).toEqual({ status: 'FAILED' });
  });

  it('classifies transport errors and keeps recorded errors safe', () => {
    expect(
      classifyTransportError(
        new NotificationTransportError('RATE_LIMITED', true, 'Slow down.'),
      ),
    ).toEqual({ code: 'RATE_LIMITED', retryable: true, message: 'Slow down.' });
    expect(
      classifyTransportError(new Error('smtp auth failed for pw=hunter2')),
    ).toEqual({
      code: 'TRANSPORT_ERROR',
      retryable: true,
      message: 'Unexpected transport error.',
    });
    expect(safeErrorMessage('Mailbox ada@example.com rejected')).toBe(
      'Mailbox [redacted] rejected',
    );
    expect(safeErrorMessage('x'.repeat(500))).toHaveLength(300);
    expect(safeErrorCode('mailbox-full')).toBe('MAILBOX_FULL');
    expect(safeErrorCode('550')).toBe('TRANSPORT_ERROR');
  });

  it('the development transport records ids only and refuses production', async () => {
    const dev = new DevNotificationEmailTransport(false);
    const result = await dev.send({
      to: 'ada@example.com',
      subject: 'S',
      text: 'T',
      notificationId: 'n-1',
      recipientUserId: 'u-1',
    });
    expect(result.providerReference).toBe('dev-n-1');
    expect(dev.sent).toEqual([
      { notificationId: 'n-1', recipientUserId: 'u-1' },
    ]);
    expect(JSON.stringify(dev.sent)).not.toMatch(/ada@|"S"|"T"/);
    await expect(
      new DevNotificationEmailTransport(true).send({
        to: 'a@b.c',
        subject: 'S',
        text: 'T',
        notificationId: 'n',
        recipientUserId: 'u',
      }),
    ).rejects.toMatchObject({
      code: 'EMAIL_PROVIDER_NOT_CONFIGURED',
      retryable: false,
    });
  });
});

describe('producer formatting', () => {
  it('formats instants in the organization timezone and bounds title lists', () => {
    const at = new Date('2026-03-16T15:00:00.000Z');
    expect(formatInstant(at, 'America/Toronto')).toBe(
      '2026-03-16 11:00 America/Toronto',
    );
    expect(formatInstant(at, null)).toBe('2026-03-16 15:00 UTC');
    expect(listTitles(['a', 'b'])).toBe('a, b');
    expect(listTitles(['1', '2', '3', '4', '5', '6', '7'])).toBe(
      '1, 2, 3, 4, 5 and 2 more',
    );
  });
});

describe('Batch 8 link detection (O2, review L5)', () => {
  it('detects URLs and bare domains, not ordinary names or dates', () => {
    for (const text of [
      'see evil.com',
      'portal.example.org/reset',
      'https://x.y',
      'www.x',
    ])
      expect(containsLink(text), text).toBe(true);
    for (const text of [
      'Jordan Lee',
      "Ana-María O'Neil",
      '2026-03-16',
      'e.g. leave',
    ])
      expect(containsLink(text), text).toBe(false);
  });
});
