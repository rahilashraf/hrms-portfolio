import { apiRequest } from '../auth/api-client';
import type {
  CategoryEmailInput,
  DeliveryDetail,
  DeliveryPage,
  DeliveryQuery,
  InboxQuery,
  NotificationPage,
  NotificationPreferences,
  NotificationsOrganization,
  NotificationView,
  OrganizationNotificationSettings,
  TemplateEntry,
  TemplatePreview,
  TemplateView,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** `?…` of the defined, non-empty filters (or an empty string). */
function query(filters: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '' && value !== false) {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export interface TemplateInput {
  organizationId: string;
  key: string;
  subjectTemplate: string;
  bodyTemplate: string;
}

export interface TemplateUpdate {
  subjectTemplate?: string;
  bodyTemplate?: string;
}

export interface PreviewInput {
  organizationId: string;
  key: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
}

export interface SettingsInput {
  organizationId: string;
  emailEnabled?: boolean;
  suppressMandatoryEmail?: boolean;
  categories?: CategoryEmailInput[];
}

export const notificationsApi = {
  // ─── The caller's inbox ───────────────────────────────────────────────────
  mine(filters: InboxQuery = {}): Promise<NotificationPage> {
    return apiRequest(
      `/notifications/me${query({
        limit: filters.limit,
        cursor: filters.cursor,
        unreadOnly: filters.unreadOnly,
        archived: filters.archived,
        organizationId: filters.organizationId,
      })}`,
    );
  },
  unreadCount(): Promise<{ unread: number }> {
    return apiRequest('/notifications/me/unread-count');
  },
  markRead(notificationId: string): Promise<NotificationView> {
    return send('POST', `/notifications/me/${enc(notificationId)}/read`);
  },
  markAllRead(organizationId?: string | null): Promise<{ updated: number }> {
    return send('POST', '/notifications/me/read-all', organizationId ? { organizationId } : {});
  },
  archive(notificationId: string): Promise<NotificationView> {
    return send('POST', `/notifications/me/${enc(notificationId)}/archive`);
  },

  // ─── The caller's email preferences ───────────────────────────────────────
  preferences(): Promise<NotificationPreferences> {
    return apiRequest('/notifications/me/preferences');
  },
  updatePreferences(preferences: CategoryEmailInput[]): Promise<NotificationPreferences> {
    return send('PUT', '/notifications/me/preferences', { preferences });
  },

  // ─── Organization administration ──────────────────────────────────────────
  organizations(): Promise<{ items: NotificationsOrganization[] }> {
    return apiRequest('/notifications/organizations');
  },
  templates(organizationId: string, includeArchived = false): Promise<{ items: TemplateEntry[] }> {
    return apiRequest(`/notifications/templates${query({ organizationId, includeArchived })}`);
  },
  createTemplate(input: TemplateInput): Promise<TemplateView> {
    return send('POST', '/notifications/templates', input);
  },
  updateTemplate(templateId: string, input: TemplateUpdate): Promise<TemplateView> {
    return send('PATCH', `/notifications/templates/${enc(templateId)}`, input);
  },
  archiveTemplate(templateId: string): Promise<TemplateView> {
    return send('POST', `/notifications/templates/${enc(templateId)}/archive`);
  },
  preview(input: PreviewInput): Promise<TemplatePreview> {
    return apiRequest(
      `/notifications/templates/preview${query({
        organizationId: input.organizationId,
        key: input.key,
        subjectTemplate: input.subjectTemplate,
        bodyTemplate: input.bodyTemplate,
      })}`,
    );
  },
  settings(organizationId: string): Promise<OrganizationNotificationSettings> {
    return apiRequest(`/notifications/settings${query({ organizationId })}`);
  },
  updateSettings(input: SettingsInput): Promise<OrganizationNotificationSettings> {
    return send('PUT', '/notifications/settings', input);
  },

  // ─── Batch 8: delivery log (read-only) ────────────────────────────────────
  deliveries(filters: DeliveryQuery): Promise<DeliveryPage> {
    return apiRequest(
      `/notifications/deliveries${query({
        organizationId: filters.organizationId,
        type: filters.type,
        category: filters.category,
        channel: filters.channel,
        status: filters.status,
        from: filters.from,
        to: filters.to,
        recipient: filters.recipient?.trim(),
        cursor: filters.cursor,
        limit: filters.limit,
      })}`,
    );
  },
  delivery(deliveryId: string): Promise<DeliveryDetail> {
    return apiRequest(`/notifications/deliveries/${enc(deliveryId)}`);
  },
};
