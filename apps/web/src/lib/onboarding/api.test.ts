import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { onboardingApi } from './api';
import {
  activeWorkflowId,
  isOnboardingForbidden,
  onboardingErrorCode,
  onboardingErrorMessage,
} from './errors';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

describe('onboardingApi', () => {
  it('maps organization, self-service and template routes', async () => {
    await onboardingApi.organizations();
    await onboardingApi.mine();
    await onboardingApi.myTasks();
    await onboardingApi.myTasks(true);
    await onboardingApi.templates('org-1');
    await onboardingApi.templates('org-1', 'OFFBOARDING');
    await onboardingApi.createTemplate({
      organizationId: 'org-1',
      kind: 'ONBOARDING',
      code: 'STAFF',
      name: 'Staff',
      tasks: [{ title: 'Sign', category: 'PAPERWORK', ownerType: 'EMPLOYEE' }],
    });
    await onboardingApi.updateTemplate('t/1', { name: 'Staff 2' });
    await onboardingApi.activateTemplate('t1');
    await onboardingApi.archiveTemplate('t1');
    await onboardingApi.setDefaultTemplate('t1');
    expect(calls()).toEqual([
      ['/onboarding/organizations', 'GET', undefined],
      ['/onboarding/me', 'GET', undefined],
      ['/onboarding/me/tasks', 'GET', undefined],
      ['/onboarding/me/tasks?includeDone=true', 'GET', undefined],
      ['/onboarding/templates?organizationId=org-1', 'GET', undefined],
      ['/onboarding/templates?organizationId=org-1&kind=OFFBOARDING', 'GET', undefined],
      [
        '/onboarding/templates',
        'POST',
        JSON.stringify({
          organizationId: 'org-1',
          kind: 'ONBOARDING',
          code: 'STAFF',
          name: 'Staff',
          tasks: [{ title: 'Sign', category: 'PAPERWORK', ownerType: 'EMPLOYEE' }],
        }),
      ],
      ['/onboarding/templates/t%2F1', 'PATCH', JSON.stringify({ name: 'Staff 2' })],
      ['/onboarding/templates/t1/activate', 'POST', undefined],
      ['/onboarding/templates/t1/archive', 'POST', undefined],
      ['/onboarding/templates/t1/default', 'POST', undefined],
    ]);
  });

  it('maps workflow routes', async () => {
    await onboardingApi.dashboard('org-1', 'ONBOARDING');
    await onboardingApi.dashboard('org-1', 'OFFBOARDING', true);
    await onboardingApi.employeeWorkflows('emp-1');
    await onboardingApi.startOnboarding({ employmentAssignmentId: 'asg-1', templateId: null });
    await onboardingApi.startOffboarding({
      employmentAssignmentId: 'asg-1',
      plannedEndDate: '2026-12-31',
      reason: 'Resigned',
      templateId: null,
    });
    await onboardingApi.startFromHire('hire-1');
    await onboardingApi.startFromHire('hire-1', 'tpl-1');
    await onboardingApi.workflow('wf-1');
    await onboardingApi.cancelWorkflow('wf-1', 'Started in error');
    await onboardingApi.completeWorkflow('wf-1');
    expect(calls()).toEqual([
      ['/onboarding/workflows?organizationId=org-1&kind=ONBOARDING', 'GET', undefined],
      [
        '/onboarding/workflows?organizationId=org-1&kind=OFFBOARDING&includeClosed=true',
        'GET',
        undefined,
      ],
      ['/onboarding/employees/emp-1/workflows', 'GET', undefined],
      [
        '/onboarding/workflows/onboarding',
        'POST',
        JSON.stringify({ employmentAssignmentId: 'asg-1', templateId: null }),
      ],
      [
        '/onboarding/workflows/offboarding',
        'POST',
        JSON.stringify({
          employmentAssignmentId: 'asg-1',
          plannedEndDate: '2026-12-31',
          reason: 'Resigned',
          templateId: null,
        }),
      ],
      ['/onboarding/from-hire/hire-1', 'POST', JSON.stringify({})],
      ['/onboarding/from-hire/hire-1', 'POST', JSON.stringify({ templateId: 'tpl-1' })],
      ['/onboarding/workflows/wf-1', 'GET', undefined],
      ['/onboarding/workflows/wf-1/cancel', 'POST', JSON.stringify({ reason: 'Started in error' })],
      ['/onboarding/workflows/wf-1/complete', 'POST', undefined],
    ]);
  });

  it('maps task and import routes', async () => {
    await onboardingApi.startTask('tk-1');
    await onboardingApi.completeTask('tk-1', { note: 'Done', evidenceReference: 'INV-1' });
    await onboardingApi.acknowledgeTask('tk-1');
    await onboardingApi.waiveTask('tk-1', 'Not needed');
    await onboardingApi.reopenTask('tk-1', 'Wrong form');
    await onboardingApi.reassignTask('tk-1', 'u-2');
    await onboardingApi.reassignTask('tk-1', null);
    await onboardingApi.setTaskDueDate('tk-1', '2026-11-01', 'Later start');
    await onboardingApi.setTaskDueDate('tk-1', null, 'No deadline');
    await onboardingApi.importCompletions({
      organizationId: 'org-1',
      referenceType: 'GOOGLE_FORM',
      submissions: [],
    });
    expect(calls()).toEqual([
      ['/onboarding/tasks/tk-1/start', 'POST', undefined],
      [
        '/onboarding/tasks/tk-1/complete',
        'POST',
        JSON.stringify({ note: 'Done', evidenceReference: 'INV-1' }),
      ],
      ['/onboarding/tasks/tk-1/acknowledge', 'POST', JSON.stringify({ statementAccepted: true })],
      ['/onboarding/tasks/tk-1/waive', 'POST', JSON.stringify({ reason: 'Not needed' })],
      ['/onboarding/tasks/tk-1/reopen', 'POST', JSON.stringify({ reason: 'Wrong form' })],
      ['/onboarding/tasks/tk-1/owner', 'PUT', JSON.stringify({ ownerUserId: 'u-2' })],
      ['/onboarding/tasks/tk-1/owner', 'PUT', JSON.stringify({ ownerUserId: null })],
      [
        '/onboarding/tasks/tk-1/due-date',
        'PUT',
        JSON.stringify({ dueDate: '2026-11-01', reason: 'Later start' }),
      ],
      [
        '/onboarding/tasks/tk-1/due-date',
        'PUT',
        JSON.stringify({ dueDate: null, reason: 'No deadline' }),
      ],
      [
        '/onboarding/task-completions/import',
        'POST',
        JSON.stringify({ organizationId: 'org-1', referenceType: 'GOOGLE_FORM', submissions: [] }),
      ],
    ]);
  });
});

describe('onboarding errors', () => {
  it('reads the domain code and the active workflow of a start conflict', () => {
    const error = new AuthApiError(
      'conflict',
      409,
      'The assignment already has an active onboarding.',
      {
        code: 'WORKFLOW_ALREADY_ACTIVE',
        workflowId: 'wf-9',
      },
    );
    expect(onboardingErrorCode(error)).toBe('WORKFLOW_ALREADY_ACTIVE');
    expect(activeWorkflowId(error)).toBe('wf-9');
    expect(onboardingErrorMessage(error)).toBe('The assignment already has an active onboarding.');
    expect(activeWorkflowId(new AuthApiError('conflict', 409, 'x', { code: 'OTHER' }))).toBeNull();
    expect(onboardingErrorCode(new Error('x'))).toBeNull();
  });

  it('maps statuses to readable messages', () => {
    expect(isOnboardingForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(onboardingErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this onboarding action.',
    );
    expect(onboardingErrorMessage(new AuthApiError('unexpected', 404))).toBe(
      'The onboarding record was not found.',
    );
    expect(onboardingErrorMessage(new AuthApiError('service-unavailable', 503))).toBe(
      'The Onboarding service is unavailable. Please try again.',
    );
    expect(onboardingErrorMessage(new Error('x'), 'Fallback')).toBe('Fallback');
  });
});

describe('onboardingApi.options (Batch 7A)', () => {
  it('maps the picker options route with its filters', async () => {
    await onboardingApi.options('org-1', 'owner');
    await onboardingApi.options('org-1', 'assignment', {
      workflowKind: 'OFFBOARDING',
      search: 'Ada L',
      afterId: 'a-1',
      limit: 20,
    });
    expect(calls()).toEqual([
      ['/onboarding/options?organizationId=org-1&kind=owner', 'GET', undefined],
      [
        '/onboarding/options?organizationId=org-1&kind=assignment&workflowKind=OFFBOARDING&search=Ada+L&afterId=a-1&limit=20',
        'GET',
        undefined,
      ],
    ]);
  });
});
