import { apiRequest } from '../auth/api-client';
import { readPreference, writePreference } from '../navigation/preferences';

/** GET /organizations/:organizationId/setup — derived from real data, never stored. */
export interface SetupStep {
  key: string;
  label: string;
  description: string;
  complete: boolean;
  optional: boolean;
  href: string;
  detail: string | null;
}

export interface SetupChecklist {
  organizationId: string;
  steps: SetupStep[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function step(value: unknown): SetupStep | null {
  if (!isRecord(value)) return null;
  const key = str(value.key);
  const label = str(value.label);
  const href = str(value.href);
  if (!key || !label || typeof value.complete !== 'boolean') return null;
  return {
    key,
    label,
    description: str(value.description) ?? '',
    complete: value.complete,
    optional: value.optional === true,
    // In-app links only.
    href: href && href.startsWith('/') && !href.startsWith('//') ? href : '/dashboard',
    detail: str(value.detail),
  };
}

export function parseSetupChecklist(value: unknown): SetupChecklist {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    throw new Error('Unexpected setup response.');
  }
  return {
    organizationId: str(value.organizationId) ?? '',
    steps: value.steps.map(step).filter((item): item is SetupStep => item !== null),
  };
}

export const setupApi = {
  async get(organizationId: string): Promise<SetupChecklist> {
    return parseSetupChecklist(
      await apiRequest<unknown>(`/organizations/${encodeURIComponent(organizationId)}/setup`),
    );
  },
};

/** "Hide for now" is a per-user, per-organization browser preference (guide, don't block). */
export function setupHiddenKey(userId: string, organizationId: string): string {
  return `hrms.setup.hidden.${userId}.${organizationId}`;
}

export function readSetupHidden(userId: string, organizationId: string): boolean {
  return readPreference(setupHiddenKey(userId, organizationId)) === '1';
}

export function writeSetupHidden(userId: string, organizationId: string, hidden: boolean): void {
  writePreference(setupHiddenKey(userId, organizationId), hidden ? '1' : null);
}

/** Steps the user chose to skip for now (per user, per organization). */
export function setupSkippedKey(userId: string, organizationId: string): string {
  return `hrms.setup.skipped.${userId}.${organizationId}`;
}

export function readSetupSkipped(userId: string, organizationId: string): string[] {
  const raw = readPreference(setupSkippedKey(userId, organizationId));
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function writeSetupSkipped(
  userId: string,
  organizationId: string,
  keys: readonly string[],
): void {
  writePreference(
    setupSkippedKey(userId, organizationId),
    keys.length > 0 ? JSON.stringify([...keys]) : null,
  );
}
