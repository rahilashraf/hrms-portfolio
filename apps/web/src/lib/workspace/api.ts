import { apiRequest } from '../auth/api-client';
import { ORGANIZATION_MODULES } from './types';
import type {
  OrganizationModule,
  Workspace,
  WorkspaceBranding,
  WorkspaceOrganization,
} from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const SAFE_URL = /^https:\/\//i;
const COLOR = /^#[0-9a-f]{6}$/i;

function branding(value: unknown): WorkspaceBranding | null {
  if (!isRecord(value)) return null;
  const url = (input: unknown) => {
    const text = str(input);
    return text && SAFE_URL.test(text) ? text : null;
  };
  const color = (input: unknown) => {
    const text = str(input);
    return text && COLOR.test(text) ? text : null;
  };
  return {
    displayName: str(value.displayName),
    shortName: str(value.shortName),
    logoUrl: url(value.logoUrl),
    iconUrl: url(value.iconUrl),
    primaryColor: color(value.primaryColor),
    secondaryColor: color(value.secondaryColor),
  };
}

function organization(value: unknown): WorkspaceOrganization | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  if (!id || !name) return null;
  const known = new Set<string>(ORGANIZATION_MODULES);
  return {
    id,
    name,
    code: str(value.code) ?? '',
    timezone: str(value.timezone),
    branding: branding(value.branding),
    enabledModules: strings(value.enabledModules).filter((m): m is OrganizationModule =>
      known.has(m),
    ),
    permissions: strings(value.permissions),
    isEmployee: value.isEmployee === true,
    isManager: value.isManager === true,
  };
}

/**
 * Validates the workspace response defensively: an unexpected shape is an error so the shell
 * falls back to the authorization snapshot instead of rendering a half-understood context.
 */
export function parseWorkspace(value: unknown): Workspace {
  if (!isRecord(value) || !isRecord(value.user) || !Array.isArray(value.organizations)) {
    throw new Error('Unexpected workspace response.');
  }
  const email = str(value.user.email) ?? '';
  return {
    user: {
      id: str(value.user.id) ?? '',
      email,
      displayName: str(value.user.displayName) ?? email,
    },
    systemPermissions: strings(value.systemPermissions),
    organizations: value.organizations
      .map(organization)
      .filter((item): item is WorkspaceOrganization => item !== null),
  };
}

export const workspaceApi = {
  async current(): Promise<Workspace> {
    return parseWorkspace(await apiRequest<unknown>('/auth/me/workspace'));
  },
};
