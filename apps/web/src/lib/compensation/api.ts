import { apiRequest } from '../auth/api-client';
import type {
  CompensationAsOf,
  CompensationAssignmentView,
  CompensationChangeInput,
  CompensationChangeResult,
  CompensationCorrectionInput,
  CompensationCreateInput,
  CompensationEndInput,
  CompensationRecord,
  EmployeeCompensation,
  PayGroup,
  PayGroupInput,
  PayGroupOrganization,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const base = (assignmentId: string) => `/employment-assignments/${enc(assignmentId)}/compensation`;

export const compensationApi = {
  // ─── Self-service ────────────────────────────────────────────────────────
  me(): Promise<EmployeeCompensation> {
    return apiRequest('/compensation/me');
  },

  // ─── Profile and assignment reads ────────────────────────────────────────
  employee(employeeId: string): Promise<EmployeeCompensation> {
    return apiRequest(`/compensation/employees/${enc(employeeId)}`);
  },
  history(assignmentId: string): Promise<CompensationAssignmentView> {
    return apiRequest(base(assignmentId));
  },
  asOf(assignmentId: string, date: string): Promise<CompensationAsOf> {
    return apiRequest(`${base(assignmentId)}/as-of?date=${enc(date)}`);
  },

  // ─── Management (compensation.manage) ────────────────────────────────────
  create(assignmentId: string, input: CompensationCreateInput): Promise<CompensationRecord> {
    return send('POST', base(assignmentId), input);
  },
  change(assignmentId: string, input: CompensationChangeInput): Promise<CompensationChangeResult> {
    return send('POST', `${base(assignmentId)}/change`, input);
  },
  correct(
    assignmentId: string,
    recordId: string,
    input: CompensationCorrectionInput,
  ): Promise<CompensationRecord> {
    return send('PATCH', `${base(assignmentId)}/${enc(recordId)}/correction`, input);
  },
  end(
    assignmentId: string,
    recordId: string,
    input: CompensationEndInput,
  ): Promise<CompensationRecord> {
    return send('POST', `${base(assignmentId)}/${enc(recordId)}/end`, input);
  },

  // ─── Pay groups ──────────────────────────────────────────────────────────
  payGroupOrganizations(): Promise<{ items: PayGroupOrganization[] }> {
    return apiRequest('/pay-groups/organizations');
  },
  payGroups(organizationId: string, includeArchived = false): Promise<{ items: PayGroup[] }> {
    const archived = includeArchived ? '&includeArchived=true' : '';
    return apiRequest(`/pay-groups?organizationId=${enc(organizationId)}${archived}`);
  },
  createPayGroup(input: PayGroupInput): Promise<PayGroup> {
    return send('POST', '/pay-groups', input);
  },
  updatePayGroup(
    payGroupId: string,
    input: { name?: string; description?: string },
  ): Promise<PayGroup> {
    return send('PATCH', `/pay-groups/${enc(payGroupId)}`, input);
  },
  archivePayGroup(payGroupId: string): Promise<PayGroup> {
    return send('POST', `/pay-groups/${enc(payGroupId)}/archive`);
  },
};
