import { apiRequest } from '../auth/api-client';

/** GET /dashboard?organizationId — only what the caller is authorized for. */
export interface DashboardCard {
  key: string;
  label: string;
  value: number;
  href: string;
  area: string;
}

export interface DashboardLeaveBalance {
  leaveTypeId: string;
  name: string;
  availableMinutes: number;
  pendingMinutes: number;
}

export interface DashboardSelf {
  employeeId: string;
  /** null: the module is off for the organization. */
  todayShifts: number | null;
  leaveBalances: DashboardLeaveBalance[] | null;
  policyAcknowledgementsDue: number | null;
  selfReviewsDue: number | null;
  reviewsToWrite: number | null;
  openGoals: number | null;
}

export interface DashboardQuickAction {
  key: string;
  label: string;
  href: string;
}

export interface Dashboard {
  organizationId: string;
  cards: DashboardCard[];
  self: DashboardSelf | null;
  quickActions: DashboardQuickAction[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
/** In-app links only: a relative path (never an external or scripted URL). */
const internalHref = (value: unknown): string | null => {
  const href = str(value);
  return href && href.startsWith('/') && !href.startsWith('//') ? href : null;
};

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(parse).filter((item): item is T => item !== null) : [];
}

function card(value: unknown): DashboardCard | null {
  if (!isRecord(value)) return null;
  const key = str(value.key);
  const label = str(value.label);
  const href = internalHref(value.href);
  const amount = count(value.value);
  if (!key || !label || !href || amount === null) return null;
  return { key, label, value: amount, href, area: str(value.area) ?? '' };
}

function action(value: unknown): DashboardQuickAction | null {
  if (!isRecord(value)) return null;
  const key = str(value.key);
  const label = str(value.label);
  const href = internalHref(value.href);
  return key && label && href ? { key, label, href } : null;
}

function balance(value: unknown): DashboardLeaveBalance | null {
  if (!isRecord(value)) return null;
  const leaveTypeId = str(value.leaveTypeId);
  const name = str(value.name);
  const available = count(value.availableMinutes);
  if (!leaveTypeId || !name || available === null) return null;
  return {
    leaveTypeId,
    name,
    availableMinutes: available,
    pendingMinutes: count(value.pendingMinutes) ?? 0,
  };
}

function self(value: unknown): DashboardSelf | null {
  if (!isRecord(value)) return null;
  const employeeId = str(value.employeeId);
  if (!employeeId) return null;
  return {
    employeeId,
    todayShifts: count(value.todayShifts),
    leaveBalances: Array.isArray(value.leaveBalances) ? list(value.leaveBalances, balance) : null,
    policyAcknowledgementsDue: count(value.policyAcknowledgementsDue),
    selfReviewsDue: count(value.selfReviewsDue),
    reviewsToWrite: count(value.reviewsToWrite),
    openGoals: count(value.openGoals),
  };
}

/** Keeps only well-formed cards and actions with in-app links; unknown fields are dropped. */
export function parseDashboard(value: unknown): Dashboard {
  if (!isRecord(value)) throw new Error('Unexpected dashboard response.');
  return {
    organizationId: str(value.organizationId) ?? '',
    cards: list(value.cards, card),
    self: self(value.self),
    quickActions: list(value.quickActions, action),
  };
}

export const dashboardApi = {
  async get(organizationId: string): Promise<Dashboard> {
    return parseDashboard(
      await apiRequest<unknown>(`/dashboard?organizationId=${encodeURIComponent(organizationId)}`),
    );
  },
};
