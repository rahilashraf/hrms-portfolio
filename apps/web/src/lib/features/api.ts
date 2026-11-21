import { apiRequest } from '../auth/api-client';
import type {
  FeatureHistoryPage,
  FeaturesOrganization,
  FeaturesOverview,
  ModuleState,
  SettingState,
  SettingValue,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  return apiRequest(path, { method, body: JSON.stringify(body) });
}

export interface HistoryQuery {
  limit?: number;
  before?: string | null;
}

export const featuresApi = {
  organizations(): Promise<{ items: FeaturesOrganization[] }> {
    return apiRequest('/admin/features/organizations');
  },
  overview(organizationId: string): Promise<FeaturesOverview> {
    return apiRequest(`/admin/features?${new URLSearchParams({ organizationId })}`);
  },
  history(organizationId: string, query: HistoryQuery = {}): Promise<FeatureHistoryPage> {
    const params = new URLSearchParams({ organizationId });
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before) params.set('before', query.before);
    return apiRequest(`/admin/features/history?${params}`);
  },
  setModule(
    module: string,
    input: { organizationId: string; enabled: boolean; expectedVersion: number },
  ): Promise<{ module: ModuleState }> {
    return send('PUT', `/admin/features/modules/${enc(module)}`, input);
  },
  setSetting(
    key: string,
    input: {
      organizationId: string;
      value: SettingValue;
      expectedVersion: number;
      /** M2: required (with confirm) to relax a guarded setting. */
      reason?: string;
      confirm?: boolean;
    },
  ): Promise<{ setting: SettingState }> {
    return send('PUT', `/admin/features/settings/${enc(key)}`, input);
  },
  resetSetting(
    key: string,
    input: { organizationId: string; expectedVersion: number },
  ): Promise<{ setting: SettingState }> {
    return send('POST', `/admin/features/settings/${enc(key)}/reset`, input);
  },
};
