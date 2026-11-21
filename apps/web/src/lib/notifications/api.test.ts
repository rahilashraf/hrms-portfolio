import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { notificationsApi } from './api';
import {
  isNotificationsForbidden,
  isNotificationsNotFound,
  NOTIFICATIONS_ERROR_MESSAGES,
  notificationsErrorCode,
  notificationsErrorMessage,
} from './errors';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

describe('notificationsApi', () => {
  it('maps the inbox and preference routes', async () => {
    await notificationsApi.mine();
    await notificationsApi.mine({
      limit: 20,
      cursor: 'abc=',
      unreadOnly: true,
      archived: false,
      organizationId: 'org-1',
    });
    await notificationsApi.mine({ archived: true, organizationId: null });
    await notificationsApi.unreadCount();
    await notificationsApi.markRead('n/1');
    await notificationsApi.markAllRead();
    await notificationsApi.markAllRead('org-1');
    await notificationsApi.archive('n-1');
    await notificationsApi.preferences();
    await notificationsApi.updatePreferences([{ category: 'LEAVE', emailEnabled: false }]);
    expect(calls()).toEqual([
      ['/notifications/me', 'GET', undefined],
      [
        '/notifications/me?limit=20&cursor=abc%3D&unreadOnly=true&organizationId=org-1',
        'GET',
        undefined,
      ],
      ['/notifications/me?archived=true', 'GET', undefined],
      ['/notifications/me/unread-count', 'GET', undefined],
      ['/notifications/me/n%2F1/read', 'POST', undefined],
      ['/notifications/me/read-all', 'POST', JSON.stringify({})],
      ['/notifications/me/read-all', 'POST', JSON.stringify({ organizationId: 'org-1' })],
      ['/notifications/me/n-1/archive', 'POST', undefined],
      ['/notifications/me/preferences', 'GET', undefined],
      [
        '/notifications/me/preferences',
        'PUT',
        JSON.stringify({ preferences: [{ category: 'LEAVE', emailEnabled: false }] }),
      ],
    ]);
  });

  it('maps the organization, template and settings routes', async () => {
    await notificationsApi.organizations();
    await notificationsApi.templates('org-1');
    await notificationsApi.templates('org-1', true);
    await notificationsApi.createTemplate({
      organizationId: 'org-1',
      key: 'onboarding.tasks-due',
      subjectTemplate: 'Tasks',
      bodyTemplate: 'You have {{overdueCount}} overdue tasks.',
    });
    await notificationsApi.updateTemplate('tpl/1', { subjectTemplate: 'New' });
    await notificationsApi.archiveTemplate('tpl-1');
    await notificationsApi.preview({ organizationId: 'org-1', key: 'onboarding.tasks-due' });
    await notificationsApi.preview({
      organizationId: 'org-1',
      key: 'onboarding.tasks-due',
      subjectTemplate: 'Hi & bye',
      bodyTemplate: '{{overdueCount}} late',
    });
    await notificationsApi.settings('org-1');
    await notificationsApi.updateSettings({
      organizationId: 'org-1',
      emailEnabled: false,
      suppressMandatoryEmail: true,
      categories: [{ category: 'PAYROLL', emailEnabled: false }],
    });
    expect(calls()).toEqual([
      ['/notifications/organizations', 'GET', undefined],
      ['/notifications/templates?organizationId=org-1', 'GET', undefined],
      ['/notifications/templates?organizationId=org-1&includeArchived=true', 'GET', undefined],
      [
        '/notifications/templates',
        'POST',
        JSON.stringify({
          organizationId: 'org-1',
          key: 'onboarding.tasks-due',
          subjectTemplate: 'Tasks',
          bodyTemplate: 'You have {{overdueCount}} overdue tasks.',
        }),
      ],
      ['/notifications/templates/tpl%2F1', 'PATCH', JSON.stringify({ subjectTemplate: 'New' })],
      ['/notifications/templates/tpl-1/archive', 'POST', undefined],
      [
        '/notifications/templates/preview?organizationId=org-1&key=onboarding.tasks-due',
        'GET',
        undefined,
      ],
      [
        '/notifications/templates/preview?organizationId=org-1&key=onboarding.tasks-due&subjectTemplate=Hi+%26+bye&bodyTemplate=%7B%7BoverdueCount%7D%7D+late',
        'GET',
        undefined,
      ],
      ['/notifications/settings?organizationId=org-1', 'GET', undefined],
      [
        '/notifications/settings',
        'PUT',
        JSON.stringify({
          organizationId: 'org-1',
          emailEnabled: false,
          suppressMandatoryEmail: true,
          categories: [{ category: 'PAYROLL', emailEnabled: false }],
        }),
      ],
    ]);
  });
});

describe('notifications errors', () => {
  it('has a friendly message for every notifications domain error code', () => {
    for (const code of [
      'NOTIFICATION_TEMPLATE_INVALID',
      'NOTIFICATION_TEMPLATE_SYNTAX',
      'NOTIFICATION_TEMPLATE_PLACEHOLDER',
      'NOTIFICATION_TEMPLATE_LINK',
      'NOTIFICATION_TEMPLATE_EXISTS',
      'NOTIFICATION_TEMPLATE_ARCHIVED',
      'NOTIFICATION_TYPE_UNKNOWN',
      'NOTIFICATION_CATEGORY_MANDATORY',
      'NOTIFICATION_CATEGORY_DUPLICATE',
      'NOTIFICATION_CATEGORY_UNKNOWN',
      'NOTIFICATION_MANDATORY_SUPPRESSION',
      'NOTIFICATION_CURSOR_INVALID',
      'NOTIFICATION_LINK_INVALID',
      'NOTIFICATION_DEDUPE_INVALID',
      'NOTIFICATION_RECIPIENT_INVALID',
      'NOTIFICATION_SOURCE_INVALID',
    ]) {
      const error = new AuthApiError('validation', 400, 'Server text.', { code });
      expect(notificationsErrorCode(error)).toBe(code);
      expect(notificationsErrorMessage(error)).toBe(NOTIFICATIONS_ERROR_MESSAGES[code]);
    }
    expect(
      notificationsErrorMessage(
        new AuthApiError('validation', 400, 'x', { code: 'NOTIFICATION_TEMPLATE_PLACEHOLDER' }),
      ),
    ).toBe(
      'The template uses a placeholder this notification does not provide. Use only the listed variables.',
    );
    expect(
      notificationsErrorMessage(
        new AuthApiError('conflict', 409, 'Server says no.', { code: 'SOMETHING_NEW' }),
      ),
    ).toBe('Server says no.');
    expect(notificationsErrorCode(new Error('x'))).toBeNull();
  });

  it('maps statuses to readable messages', () => {
    expect(isNotificationsForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(isNotificationsNotFound(new AuthApiError('unexpected', 404))).toBe(true);
    expect(notificationsErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this notifications action.',
    );
    expect(notificationsErrorMessage(new AuthApiError('unexpected', 404))).toBe(
      'The notification was not found.',
    );
    expect(notificationsErrorMessage(new AuthApiError('unauthenticated', 401))).toBe(
      'Your session has expired. Please sign in again.',
    );
    expect(notificationsErrorMessage(new AuthApiError('validation', 400, 'Bad limit.'))).toBe(
      'Bad limit.',
    );
    expect(notificationsErrorMessage(new AuthApiError('service-unavailable', 503))).toBe(
      'The Notifications service is unavailable. Please try again.',
    );
    expect(notificationsErrorMessage(new Error('x'), 'Fallback')).toBe('Fallback');
  });
});
