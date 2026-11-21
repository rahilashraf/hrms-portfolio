import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { recruitmentApi } from './api';
import {
  isRecruitmentForbidden,
  possibleExistingEmployees,
  recruitmentErrorCode,
  recruitmentErrorMessage,
} from './errors';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

describe('recruitmentApi', () => {
  it('maps organization, dashboard, stage and opening routes', async () => {
    await recruitmentApi.organizations();
    await recruitmentApi.dashboard('org-1');
    await recruitmentApi.stages('org-1');
    await recruitmentApi.stages('org-1', true);
    await recruitmentApi.createStage({
      organizationId: 'org-1',
      code: 'REF',
      name: 'References',
      kind: 'REFERENCE_CHECK',
    });
    await recruitmentApi.updateStage('s/1', { name: 'Refs' });
    await recruitmentApi.archiveStage('s1');
    await recruitmentApi.reorderStages('org-1', ['s2', 's1']);
    await recruitmentApi.initializeStages('org-1');
    await recruitmentApi.openings('org-1', { status: 'OPEN', search: 'camp counsellor' });
    await recruitmentApi.opening('op-1');
    await recruitmentApi.createOpening({
      organizationId: 'org-1',
      code: 'R',
      title: 'T',
      employmentType: 'CASUAL',
    });
    await recruitmentApi.updateOpening('op-1', { title: 'T2' });
    await recruitmentApi.transitionOpening('op-1', 'hold', 'Budget');
    await recruitmentApi.transitionOpening('op-1', 'open');
    expect(calls()).toEqual([
      ['/recruitment/organizations', 'GET', undefined],
      ['/recruitment/dashboard?organizationId=org-1', 'GET', undefined],
      ['/recruitment/stages?organizationId=org-1', 'GET', undefined],
      ['/recruitment/stages?organizationId=org-1&includeArchived=true', 'GET', undefined],
      [
        '/recruitment/stages',
        'POST',
        JSON.stringify({
          organizationId: 'org-1',
          code: 'REF',
          name: 'References',
          kind: 'REFERENCE_CHECK',
        }),
      ],
      ['/recruitment/stages/s%2F1', 'PATCH', JSON.stringify({ name: 'Refs' })],
      ['/recruitment/stages/s1/archive', 'POST', undefined],
      [
        '/recruitment/stages/reorder',
        'POST',
        JSON.stringify({ organizationId: 'org-1', stageIds: ['s2', 's1'] }),
      ],
      ['/recruitment/stages/initialize', 'POST', JSON.stringify({ organizationId: 'org-1' })],
      [
        '/recruitment/openings?organizationId=org-1&status=OPEN&search=camp+counsellor',
        'GET',
        undefined,
      ],
      ['/recruitment/openings/op-1', 'GET', undefined],
      [
        '/recruitment/openings',
        'POST',
        JSON.stringify({
          organizationId: 'org-1',
          code: 'R',
          title: 'T',
          employmentType: 'CASUAL',
        }),
      ],
      ['/recruitment/openings/op-1', 'PATCH', JSON.stringify({ title: 'T2' })],
      ['/recruitment/openings/op-1/hold', 'POST', JSON.stringify({ reason: 'Budget' })],
      ['/recruitment/openings/op-1/open', 'POST', JSON.stringify({})],
    ]);
  });

  it('maps candidate, document and application routes', async () => {
    await recruitmentApi.candidates('org-1', { search: 'ada' });
    await recruitmentApi.candidate('c1');
    await recruitmentApi.createCandidate({
      organizationId: 'org-1',
      firstName: 'Ada',
      lastName: 'L',
    });
    await recruitmentApi.updateCandidate('c1', { phone: null });
    await recruitmentApi.setInternalEmployee('c1', 'e1');
    await recruitmentApi.archiveCandidate('c1');
    await recruitmentApi.mergeCandidate('c1', 'c2');
    await recruitmentApi.addDocument('c1', {
      kind: 'RESUME',
      title: 'CV',
      provider: 'EXTERNAL_URL',
      externalUrl: 'https://x.test/cv',
    });
    await recruitmentApi.removeDocument('d1', 'Wrong file');
    await recruitmentApi.applications('org-1', { openingId: 'op-1', status: 'ACTIVE' });
    await recruitmentApi.application('a1');
    await recruitmentApi.createApplication({ openingId: 'op-1', candidateId: 'c1' });
    await recruitmentApi.moveStage('a1', 's2');
    await recruitmentApi.recordScreening('a1', { outcome: 'ADVANCE' });
    await recruitmentApi.withdraw('a1', 'Moved away');
    await recruitmentApi.reject('a1', 'Not qualified');
    expect(calls().map(([path, method]) => [path, method])).toEqual([
      ['/recruitment/candidates?organizationId=org-1&search=ada', 'GET'],
      ['/recruitment/candidates/c1', 'GET'],
      ['/recruitment/candidates', 'POST'],
      ['/recruitment/candidates/c1', 'PATCH'],
      ['/recruitment/candidates/c1/internal-employee', 'PUT'],
      ['/recruitment/candidates/c1/archive', 'POST'],
      ['/recruitment/candidates/c1/merge', 'POST'],
      ['/recruitment/candidates/c1/documents', 'POST'],
      ['/recruitment/documents/d1/remove', 'POST'],
      ['/recruitment/applications?organizationId=org-1&openingId=op-1&status=ACTIVE', 'GET'],
      ['/recruitment/applications/a1', 'GET'],
      ['/recruitment/applications', 'POST'],
      ['/recruitment/applications/a1/stage', 'POST'],
      ['/recruitment/applications/a1/screening', 'PUT'],
      ['/recruitment/applications/a1/withdraw', 'POST'],
      ['/recruitment/applications/a1/reject', 'POST'],
    ]);
    expect(apiRequest.mock.calls[6]![1].body).toBe(JSON.stringify({ intoCandidateId: 'c2' }));
    expect(apiRequest.mock.calls[12]![1].body).toBe(JSON.stringify({ stageId: 's2', note: null }));
  });

  it('maps interview, feedback, offer, hire and intake routes', async () => {
    await recruitmentApi.myInterviews();
    await recruitmentApi.scheduleInterview('a1', {
      type: 'VIDEO',
      title: 'T',
      scheduledStart: '2026-10-10T13:30:00.000Z',
      durationMinutes: 30,
    });
    await recruitmentApi.rescheduleInterview('i1', { durationMinutes: 45 });
    await recruitmentApi.completeInterview('i1');
    await recruitmentApi.noShowInterview('i1');
    await recruitmentApi.cancelInterview('i1', 'Sick');
    await recruitmentApi.addInterviewer('i1', 'u1');
    await recruitmentApi.removeInterviewer('i1', 'u1');
    await recruitmentApi.feedbackHistory('i1');
    await recruitmentApi.saveFeedback('i1', { rating: 4 });
    await recruitmentApi.submitFeedback('i1', { rating: 4 });
    await recruitmentApi.reopenFeedback('f1', 'Incomplete');
    await recruitmentApi.createOffer('a1', {
      positionId: 'p',
      employmentType: 'CASUAL',
      startDate: '2026-11-01',
      payBasis: 'HOURLY',
      rateAmount: '20.00',
      currency: 'CAD',
    });
    await recruitmentApi.updateOffer('o1', { rateAmount: '21.00' });
    await recruitmentApi.offerAction('o1', 'approve');
    await recruitmentApi.offerAction('o1', 'decline', 'Other job');
    await recruitmentApi.hire('a1', { confirmNewPerson: true });
    await recruitmentApi.intakeSources('org-1');
    await recruitmentApi.createIntakeSource({
      organizationId: 'org-1',
      code: 'GF',
      name: 'Form',
      provider: 'GOOGLE_FORMS',
    });
    await recruitmentApi.updateIntakeSource('src1', { name: 'Form 2' });
    await recruitmentApi.archiveIntakeSource('src1');
    await recruitmentApi.importSubmissions('src1', []);
    await recruitmentApi.intake('org-1');
    await recruitmentApi.assignOpening('sub1', 'op-1');
    await recruitmentApi.rejectSubmission('sub1', 'Spam');
    expect(calls().map(([path, method]) => [path, method])).toEqual([
      ['/recruitment/me/interviews', 'GET'],
      ['/recruitment/applications/a1/interviews', 'POST'],
      ['/recruitment/interviews/i1', 'PATCH'],
      ['/recruitment/interviews/i1/complete', 'POST'],
      ['/recruitment/interviews/i1/no-show', 'POST'],
      ['/recruitment/interviews/i1/cancel', 'POST'],
      ['/recruitment/interviews/i1/interviewers', 'POST'],
      ['/recruitment/interviews/i1/interviewers/u1', 'DELETE'],
      ['/recruitment/interviews/i1/feedback', 'GET'],
      ['/recruitment/interviews/i1/feedback/me', 'PUT'],
      ['/recruitment/interviews/i1/feedback/me/submit', 'POST'],
      ['/recruitment/feedback/f1/reopen', 'POST'],
      ['/recruitment/applications/a1/offers', 'POST'],
      ['/recruitment/offers/o1', 'PATCH'],
      ['/recruitment/offers/o1/approve', 'POST'],
      ['/recruitment/offers/o1/decline', 'POST'],
      ['/recruitment/applications/a1/hire', 'POST'],
      ['/recruitment/intake-sources?organizationId=org-1', 'GET'],
      ['/recruitment/intake-sources', 'POST'],
      ['/recruitment/intake-sources/src1', 'PATCH'],
      ['/recruitment/intake-sources/src1/archive', 'POST'],
      ['/recruitment/intake-sources/src1/import', 'POST'],
      ['/recruitment/intake?organizationId=org-1&status=PENDING_OPENING', 'GET'],
      ['/recruitment/intake/sub1/assign-opening', 'POST'],
      ['/recruitment/intake/sub1/reject', 'POST'],
    ]);
    expect(apiRequest.mock.calls[15]![1].body).toBe(JSON.stringify({ reason: 'Other job' }));
    expect(apiRequest.mock.calls[21]![1].body).toBe(JSON.stringify({ submissions: [] }));
  });
});

describe('recruitment errors', () => {
  it('reads the domain code and possible existing employees of a hire conflict', () => {
    const matches = [{ employeeId: 'e1', employeeNumber: 'E-1', status: 'ACTIVE' }];
    const error = new AuthApiError('conflict', 409, 'An employee with this email already exists.', {
      code: 'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE',
      matches,
    });
    expect(recruitmentErrorCode(error)).toBe('RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE');
    expect(possibleExistingEmployees(error)).toEqual(matches);
    expect(recruitmentErrorMessage(error)).toBe('An employee with this email already exists.');
    expect(
      possibleExistingEmployees(new AuthApiError('conflict', 409, 'x', { code: 'OTHER' })),
    ).toBeNull();
    expect(possibleExistingEmployees(new Error('x'))).toBeNull();
  });

  it('maps statuses to readable messages', () => {
    expect(isRecruitmentForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(recruitmentErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this recruitment action.',
    );
    expect(recruitmentErrorMessage(new AuthApiError('unexpected', 404))).toBe(
      'The recruitment record was not found.',
    );
    expect(recruitmentErrorMessage(new AuthApiError('service-unavailable', 503))).toBe(
      'The Recruitment service is unavailable. Please try again.',
    );
  });
});
