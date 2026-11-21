import { apiRequest } from '../auth/api-client';
import type {
  ConnectionResult,
  CreateBindingInput,
  DisconnectResult,
  GoogleCapability,
  GoogleFormBinding,
  GoogleOrganization,
  GoogleSources,
  GoogleWorkspaceStatus,
  HealthCheckResult,
  OAuthStartResult,
  ServiceAccountInput,
  SyncResult,
  SyncRunPage,
  SyncRunQuery,
  UpdateBindingInput,
} from './types';

const enc = encodeURIComponent;
const BASE = '/integrations/google';

function send<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return apiRequest(`${BASE}${path}`, {
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

export const googleWorkspaceApi = {
  organizations(): Promise<{ items: GoogleOrganization[] }> {
    return apiRequest(`${BASE}/organizations`);
  },
  status(organizationId: string): Promise<GoogleWorkspaceStatus> {
    return apiRequest(`${BASE}/status${query({ organizationId })}`);
  },
  /**
   * Starts an OAuth authorization. The API also sets an HttpOnly cookie that binds the
   * callback to this browser, so the request carries credentials.
   */
  startOAuth(organizationId: string, capabilities: GoogleCapability[]): Promise<OAuthStartResult> {
    return apiRequest(`${BASE}/oauth/start`, {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ organizationId, capabilities }),
    });
  },
  connectServiceAccount(input: ServiceAccountInput): Promise<ConnectionResult> {
    return send('POST', '/service-account', input);
  },
  disconnect(organizationId: string): Promise<DisconnectResult> {
    return send('POST', '/disconnect', { organizationId });
  },
  healthCheck(organizationId: string): Promise<HealthCheckResult> {
    return send('POST', '/health-check', { organizationId });
  },
  sources(organizationId: string): Promise<GoogleSources> {
    return apiRequest(`${BASE}/sources${query({ organizationId })}`);
  },
  bindings(
    organizationId: string,
    includeArchived = false,
  ): Promise<{ items: GoogleFormBinding[] }> {
    return apiRequest(`${BASE}/bindings${query({ organizationId, includeArchived })}`);
  },
  createBinding(input: CreateBindingInput): Promise<GoogleFormBinding> {
    return send('POST', '/bindings', input);
  },
  updateBinding(bindingId: string, input: UpdateBindingInput): Promise<GoogleFormBinding> {
    return send('PATCH', `/bindings/${enc(bindingId)}`, input);
  },
  archiveBinding(bindingId: string): Promise<GoogleFormBinding> {
    return send('POST', `/bindings/${enc(bindingId)}/archive`);
  },
  syncBinding(bindingId: string): Promise<SyncResult> {
    return send('POST', `/bindings/${enc(bindingId)}/sync`);
  },
  syncRuns(input: SyncRunQuery): Promise<SyncRunPage> {
    return apiRequest(
      `${BASE}/sync-runs${query({
        organizationId: input.organizationId,
        bindingId: input.bindingId,
        limit: input.limit,
        offset: input.offset,
      })}`,
    );
  },
};
