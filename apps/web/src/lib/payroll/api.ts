import { apiRequest } from '../auth/api-client';
import type {
  AdjustmentInput,
  CalendarInput,
  CalendarUpdateInput,
  ManualLineInput,
  MyPayItem,
  PayGroupMember,
  PayrollAdjustment,
  PayrollCalendar,
  PayrollEmployeeDetail,
  PayrollFreshness,
  PayrollIssue,
  PayrollOrganization,
  PayrollPayGroup,
  PayrollPeriod,
  PayrollRunDetail,
  PayrollRunSummary,
  Payslip,
  RetroDifference,
  SalaryUnpaidLeaveRuleInput,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const org = (organizationId: string) => `organizationId=${enc(organizationId)}`;
const run = (runId: string) => `/payroll/runs/${enc(runId)}`;

export const payrollApi = {
  // ─── Self-service (own identity; no payroll permission) ──────────────────
  myPay(): Promise<{ items: MyPayItem[]; netPayExplanation: string }> {
    return apiRequest('/payroll/me/pay');
  },
  payslip(runEmployeeId: string): Promise<Payslip> {
    return apiRequest(`/payroll/me/pay/${enc(runEmployeeId)}`);
  },

  // ─── Configuration ──────────────────────────────────────────────────────
  organizations(): Promise<{ items: PayrollOrganization[] }> {
    return apiRequest('/payroll/organizations');
  },
  payGroups(organizationId: string): Promise<{ items: PayrollPayGroup[] }> {
    return apiRequest(`/payroll/pay-groups?${org(organizationId)}`);
  },
  calendars(organizationId: string): Promise<{ items: PayrollCalendar[] }> {
    return apiRequest(`/payroll/calendars?${org(organizationId)}`);
  },
  createCalendar(input: CalendarInput): Promise<PayrollCalendar> {
    return send('POST', '/payroll/calendars', input);
  },
  /** Only while the calendar has no generated periods (PAYROLL_CALENDAR_IN_USE otherwise). */
  updateCalendar(calendarId: string, input: CalendarUpdateInput): Promise<PayrollCalendar> {
    return send('PATCH', `/payroll/calendars/${enc(calendarId)}`, input);
  },
  /** Never before the end of its last generated period (PAYROLL_CALENDAR_END_BEFORE_PERIODS). */
  endCalendar(calendarId: string, effectiveTo: string): Promise<PayrollCalendar> {
    return send('POST', `/payroll/calendars/${enc(calendarId)}/end`, { effectiveTo });
  },
  payGroupMembers(payGroupId: string): Promise<{ items: PayGroupMember[] }> {
    return apiRequest(`/payroll/pay-groups/${enc(payGroupId)}/members`);
  },
  setSalaryUnpaidLeaveRule(
    calendarId: string,
    input: SalaryUnpaidLeaveRuleInput,
  ): Promise<PayrollCalendar> {
    return send('POST', `/payroll/calendars/${enc(calendarId)}/salary-unpaid-leave-rule`, input);
  },
  periods(organizationId: string): Promise<{ items: PayrollPeriod[] }> {
    return apiRequest(`/payroll/periods?${org(organizationId)}`);
  },
  generatePeriods(payGroupId: string, throughDate: string): Promise<{ created: PayrollPeriod[] }> {
    return send('POST', '/payroll/periods/generate', { payGroupId, throughDate });
  },
  materializeTimesheets(periodId: string): Promise<unknown> {
    return send('POST', `/payroll/periods/${enc(periodId)}/materialize-timesheets`);
  },

  // ─── Runs ───────────────────────────────────────────────────────────────
  runs(organizationId: string): Promise<{ items: PayrollRunSummary[]; dualControl?: boolean }> {
    return apiRequest(`/payroll/runs?${org(organizationId)}`);
  },
  createRun(payrollPeriodId: string, currency: string): Promise<PayrollRunDetail> {
    return send('POST', '/payroll/runs', { payrollPeriodId, currency });
  },
  run(runId: string): Promise<PayrollRunDetail> {
    return apiRequest(run(runId));
  },
  issues(runId: string): Promise<{ items: PayrollIssue[] }> {
    return apiRequest(`${run(runId)}/issues`);
  },
  employee(runId: string, runEmployeeId: string): Promise<PayrollEmployeeDetail> {
    return apiRequest(`${run(runId)}/employees/${enc(runEmployeeId)}`);
  },
  freshness(runId: string): Promise<PayrollFreshness> {
    return apiRequest(`${run(runId)}/freshness`);
  },
  calculate(runId: string): Promise<PayrollRunDetail> {
    return send('POST', `${run(runId)}/calculate`);
  },
  approve(runId: string): Promise<PayrollRunDetail> {
    return send('POST', `${run(runId)}/approve`);
  },
  finalize(runId: string): Promise<PayrollRunDetail> {
    return send('POST', `${run(runId)}/finalize`);
  },
  void(runId: string, reason: string): Promise<PayrollRunDetail> {
    return send('POST', `${run(runId)}/void`, { reason });
  },
  addManualLine(runId: string, input: ManualLineInput): Promise<PayrollRunDetail> {
    return send('POST', `${run(runId)}/manual-lines`, input);
  },
  reverseManualLine(
    runId: string,
    lineId: string,
    kind: ManualLineInput['kind'],
    reason: string,
  ): Promise<PayrollRunDetail> {
    return send('POST', `${run(runId)}/manual-lines/${enc(lineId)}/reverse`, { kind, reason });
  },
  retroPreview(runId: string): Promise<{ payrollRunId: string; items: RetroDifference[] }> {
    return apiRequest(`${run(runId)}/retro-preview`);
  },
  createRetroAdjustments(
    runId: string,
    reason: string,
  ): Promise<{
    created: string[];
    blocked: string[];
    skippedOwnPay: string[];
    resolved?: string[];
    benefitDifferences?: string[];
  }> {
    return send('POST', `${run(runId)}/retro-adjustments`, { reason });
  },
  /** Batch 7C (C2): a person resolves a benefit-only difference explicitly. */
  resolveBenefitDifference(
    runId: string,
    input: {
      employmentAssignmentId: string;
      outcome: 'ADJUSTED' | 'NO_ADJUSTMENT_REQUIRED';
      reason: string;
      adjustmentId?: string;
      /** Created with the resolution in one transaction (no stray adjustment on retry). */
      adjustment?: { amount: string; description?: string };
    },
  ): Promise<{ resolved: boolean; alreadyResolved: boolean; adjustmentId?: string | null }> {
    return send('POST', `${run(runId)}/retro-benefit-resolutions`, input);
  },

  // ─── Adjustments ────────────────────────────────────────────────────────
  adjustments(
    organizationId: string,
    filter: {
      payrollRunId?: string;
      sourceRunId?: string;
      status?: 'PENDING' | 'APPLIED' | 'CANCELLED';
    } = {},
  ): Promise<{ items: PayrollAdjustment[] }> {
    const extra = Object.entries(filter)
      .filter(([, value]) => value)
      .map(([key, value]) => `&${key}=${enc(value!)}`)
      .join('');
    return apiRequest(`/payroll/adjustments?${org(organizationId)}${extra}`);
  },
  createAdjustment(input: AdjustmentInput): Promise<PayrollAdjustment> {
    return send('POST', '/payroll/adjustments', input);
  },
  cancelAdjustment(adjustmentId: string, reason: string): Promise<unknown> {
    return send('POST', `/payroll/adjustments/${enc(adjustmentId)}/cancel`, { reason });
  },
};
