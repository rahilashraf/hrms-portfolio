import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  ApplicationActions,
  ApplicationDetail,
  CandidateDocument,
  Dashboard,
  MyInterview,
  Offer,
  Opening,
} from '../../lib/recruitment/types';
import { ApplicationPage } from './application-page';
import { CandidatePage } from './candidate-page';
import { MyInterviewsPage } from './my-interviews-page';
import { RecruitmentAdminPage } from './recruitment-admin-page';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    dashboard: vi.fn(),
    stages: vi.fn(),
    createStage: vi.fn(),
    updateStage: vi.fn(),
    archiveStage: vi.fn(),
    reorderStages: vi.fn(),
    initializeStages: vi.fn(),
    openings: vi.fn(),
    opening: vi.fn(),
    createOpening: vi.fn(),
    updateOpening: vi.fn(),
    transitionOpening: vi.fn(),
    candidates: vi.fn(),
    candidate: vi.fn(),
    createCandidate: vi.fn(),
    updateCandidate: vi.fn(),
    setInternalEmployee: vi.fn(),
    archiveCandidate: vi.fn(),
    mergeCandidate: vi.fn(),
    addDocument: vi.fn(),
    removeDocument: vi.fn(),
    applications: vi.fn(),
    application: vi.fn(),
    createApplication: vi.fn(),
    moveStage: vi.fn(),
    recordScreening: vi.fn(),
    withdraw: vi.fn(),
    reject: vi.fn(),
    myInterviews: vi.fn(),
    scheduleInterview: vi.fn(),
    rescheduleInterview: vi.fn(),
    completeInterview: vi.fn(),
    noShowInterview: vi.fn(),
    cancelInterview: vi.fn(),
    addInterviewer: vi.fn(),
    removeInterviewer: vi.fn(),
    feedbackHistory: vi.fn(),
    saveFeedback: vi.fn(),
    submitFeedback: vi.fn(),
    reopenFeedback: vi.fn(),
    createOffer: vi.fn(),
    updateOffer: vi.fn(),
    offerAction: vi.fn(),
    hire: vi.fn(),
    intakeSources: vi.fn(),
    createIntakeSource: vi.fn(),
    updateIntakeSource: vi.fn(),
    archiveIntakeSource: vi.fn(),
    importSubmissions: vi.fn(),
    intake: vi.fn(),
    assignOpening: vi.fn(),
    rejectSubmission: vi.fn(),
    options: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/recruitment/api', () => ({ recruitmentApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const organization = (overrides = {}) => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  actions: {
    canManagePipeline: false,
    canManageIntake: false,
    canReadAllCandidates: true,
    canManageCandidates: true,
    canCreateOpenings: true,
    ...overrides,
  },
});

const opening = (overrides: Partial<Opening> = {}): Opening => ({
  id: 'op-1',
  organization: { id: 'org-1', name: 'Camp' },
  code: 'REQ-1',
  title: 'Camp Counsellor',
  description: null,
  status: 'OPEN',
  statusReason: null,
  employmentType: 'CASUAL',
  openingCount: 3,
  hiredCount: 1,
  position: { id: 'pos-1', name: 'Counsellor', code: 'CNS' },
  organizationalUnit: null,
  department: null,
  team: null,
  workLocation: null,
  hiringManager: null,
  recruiterUserId: null,
  expectedStartDate: null,
  postedOn: '2026-09-01',
  closesOn: '2026-10-31',
  compensation: { payBasis: 'HOURLY', min: '18.00', max: '21.00', currency: 'CAD' },
  openedAt: '2026-09-01T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  actions: { canManage: true, canApproveOffers: false, canHire: false, isHiringManager: false },
  applications: { ACTIVE: 2 },
  ...overrides,
});

const dashboard = (): Dashboard => ({
  today: '2026-10-06',
  openings: { byStatus: { OPEN: 2, ON_HOLD: 1 }, total: 3 },
  pipeline: [
    {
      opening: {
        id: 'op-1',
        code: 'REQ-1',
        title: 'Camp Counsellor',
        status: 'OPEN',
        openingCount: 3,
        hiredCount: 1,
      },
      stages: [
        { stageId: 's-1', name: 'Applied', count: 4 },
        { stageId: 's-2', name: 'Interview', count: 2 },
      ],
    },
  ],
  attention: {
    overdueFeedback: [
      {
        interviewId: 'i-1',
        applicationId: 'app-1',
        title: 'Panel interview',
        candidate: 'Ada Lovelace',
        opening: { id: 'op-1', title: 'Camp Counsellor', code: 'REQ-1' },
        feedbackDueAt: '2026-10-01T12:00:00.000Z',
        missing: 2,
      },
    ],
    upcomingInterviews: [],
    offersAwaitingApproval: [
      {
        offerId: 'of-1',
        applicationId: 'app-2',
        candidate: 'Grace Hopper',
        opening: { id: 'op-1', title: 'Camp Counsellor', code: 'REQ-1' },
        status: 'DRAFT',
        expiresOn: null,
      },
    ],
    offersExpiringSoon: [
      {
        offerId: 'of-2',
        applicationId: 'app-3',
        candidate: 'Alan Turing',
        opening: { id: 'op-1', title: 'Camp Counsellor', code: 'REQ-1' },
        status: 'SENT',
        expiresOn: '2026-10-08',
        expired: false,
      },
    ],
    acceptedNotHired: [
      {
        offerId: 'of-3',
        applicationId: 'app-4',
        candidate: 'Katherine Johnson',
        opening: { id: 'op-1', title: 'Camp Counsellor', code: 'REQ-1' },
        status: 'ACCEPTED',
        expiresOn: null,
      },
    ],
    staleApplications: [],
    openingsPastClose: [
      { openingId: 'op-2', code: 'REQ-2', title: 'Lifeguard', closesOn: '2026-09-30' },
    ],
    pendingIntake: 5,
  },
});

const allowed = (overrides: Partial<ApplicationActions> = {}): ApplicationActions => ({
  canManage: false,
  canMoveStage: false,
  canScreen: false,
  canScheduleInterview: false,
  canWithdraw: false,
  canReject: false,
  canCreateOffer: false,
  canApproveOffer: false,
  canHire: false,
  ...overrides,
});

const offer = (overrides: Partial<Offer> = {}): Offer => ({
  id: 'of-1',
  applicationId: 'app-1',
  positionId: 'pos-1',
  workLocationId: null,
  employmentType: 'CASUAL',
  startDate: '2026-11-01',
  payBasis: 'HOURLY',
  rateAmount: '20.00',
  currency: 'CAD',
  expiresOn: '2026-10-20',
  candidateTerms: null,
  internalNotes: null,
  status: 'DRAFT',
  effectiveStatus: 'DRAFT',
  approvedAt: null,
  approvedByUserId: null,
  sentAt: null,
  respondedAt: null,
  declineReason: null,
  withdrawnAt: null,
  withdrawalReason: null,
  expiredAt: null,
  createdByUserId: 'u-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const document = (overrides: Partial<CandidateDocument> = {}): CandidateDocument => ({
  id: 'doc-1',
  candidateId: 'cand-1',
  applicationId: 'app-1',
  kind: 'RESUME',
  title: 'Résumé',
  provider: 'GOOGLE_DRIVE',
  externalUrl: 'https://drive.example.com/file/1',
  externalFileId: null,
  fileName: null,
  mimeType: null,
  addedAt: '2026-09-02T00:00:00.000Z',
  removedAt: null,
  ...overrides,
});

const application = (overrides: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  id: 'app-1',
  view: 'FULL',
  status: 'ACTIVE',
  source: 'DIRECT',
  sourceDetail: null,
  appliedAt: '2026-09-02T00:00:00.000Z',
  stageEnteredAt: '2026-09-10T00:00:00.000Z',
  stage: { id: 's-2', name: 'Interview', kind: 'INTERVIEW' },
  organization: { id: 'org-1', name: 'Camp' },
  opening: {
    id: 'op-1',
    code: 'REQ-1',
    title: 'Camp Counsellor',
    status: 'OPEN',
    positionId: 'pos-1',
    employmentType: 'CASUAL',
  },
  candidate: {
    id: 'cand-1',
    organizationId: 'org-1',
    displayName: 'Ada Lovelace',
    firstName: 'Ada',
    lastName: 'Lovelace',
    preferredName: null,
    status: 'ACTIVE',
    source: 'DIRECT',
    internal: false,
    internalEmployee: null,
    mergedIntoCandidateId: null,
    hired: false,
    email: 'ada@example.org',
    phone: '555-0100',
    location: null,
    notes: null,
    createdAt: '2026-09-02T00:00:00.000Z',
  },
  interviews: [
    {
      id: 'int-1',
      applicationId: 'app-1',
      type: 'VIDEO',
      title: 'Panel interview',
      scheduledStart: '2026-09-20T15:00:00.000Z',
      durationMinutes: 45,
      location: null,
      meetingUrl: 'https://meet.example.com/abc',
      status: 'COMPLETED',
      feedbackDueAt: '2026-09-22T15:00:00.000Z',
      completedAt: '2026-09-20T16:00:00.000Z',
      cancelledAt: null,
      cancellationReason: null,
      interviewers: [{ userId: 'u-9', email: 'grace@example.org', feedbackSubmitted: true }],
      feedback: [
        {
          id: 'fb-1',
          interviewId: 'int-1',
          interviewerUserId: 'u-9',
          status: 'SUBMITTED',
          recommendation: 'STRONG_YES',
          rating: 5,
          strengths: 'Great with campers',
          concerns: null,
          comments: null,
          submittedAt: '2026-09-21T00:00:00.000Z',
          revision: 1,
          reopenReason: null,
          supersededAt: null,
        },
      ],
      pendingFeedback: 0,
      feedbackOverdue: false,
      isInterviewer: false,
    },
  ],
  documents: [document()],
  dispositionReason: null,
  dispositionAt: null,
  transitions: [],
  activity: [
    {
      id: 'act-1',
      applicationId: 'app-1',
      type: 'APPLICATION_RECEIVED',
      summary: 'Application received for Camp Counsellor',
      relatedId: null,
      actorUserId: null,
      occurredAt: '2026-09-02T00:00:00.000Z',
    },
  ],
  hire: null,
  screening: null,
  offers: [],
  actions: allowed({ canManage: true }),
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReset();
  auth([]);
});

// Batch 10E-1: tab clicks now write the section into the URL (#openings); every test starts
// from a clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('RecruitmentAdminPage', () => {
  it('is forbidden without recruitment permissions and no reachable organization', async () => {
    auth(['employee.manage', 'performance.manage']);
    api.organizations.mockResolvedValue({ items: [] });
    render(<RecruitmentAdminPage />);
    expect(
      await screen.findByText('You do not have permission to view recruitment.'),
    ).toBeInTheDocument();
  });

  it('shows dashboard counts, the pipeline and attention items', async () => {
    auth(['recruitment.read']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageCandidates: false, canCreateOpenings: false })],
    });
    api.dashboard.mockResolvedValue(dashboard());
    render(<RecruitmentAdminPage />);
    const overdue = await screen.findByRole('region', { name: 'Overdue interview feedback' });
    expect(
      within(overdue).getByRole('link', { name: 'Ada Lovelace — Panel interview' }),
    ).toHaveAttribute('href', '/recruitment/applications/app-1');
    expect(within(overdue).getByText(/2 missing/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Offers awaiting approval' })).getByText(
        'Grace Hopper — Camp Counsellor',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Expires 10/08/2026')).toBeInTheDocument();
    expect(screen.getByText('Katherine Johnson — Camp Counsellor')).toBeInTheDocument();
    expect(screen.getByText(/Lifeguard \(REQ-2\)/)).toBeInTheDocument();
    expect(screen.getByText('5 submission(s) waiting for an opening.')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Interview' })).toBeInTheDocument();
    // Without intake or pipeline management there are no such tabs.
    expect(screen.queryByRole('tab', { name: 'Intake' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('lists and filters openings, creates one and asks a reason to put one on hold', async () => {
    auth(['recruitment.manage']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [opening()] });
    api.createOpening.mockResolvedValue(opening({ id: 'op-9', status: 'DRAFT' }));
    api.transitionOpening.mockResolvedValue(opening({ status: 'ON_HOLD' }));
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Openings' }));
    expect(await screen.findByText('Camp Counsellor')).toBeInTheDocument();
    expect(screen.getByText('CAD 18.00 – 21.00 / hour')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'OPEN' } });
    await waitFor(() =>
      expect(api.openings).toHaveBeenLastCalledWith('org-1', { status: 'OPEN', search: undefined }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Put on hold Camp Counsellor' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Put on hold Camp Counsellor?' });
    expect(within(dialog).getByRole('button', { name: 'Put on hold opening' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Budget review' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Put on hold opening' }));
    await waitFor(() =>
      expect(api.transitionOpening).toHaveBeenCalledWith('op-1', 'hold', 'Budget review'),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New opening' }));
    const form = screen.getByRole('form', { name: 'Create opening' });
    fireEvent.change(within(form).getByLabelText('Requisition code'), {
      target: { value: 'REQ-9' },
    });
    fireEvent.change(within(form).getByLabelText('Job title'), {
      target: { value: 'Lifeguard' },
    });
    fireEvent.change(within(form).getByLabelText('Employment type'), {
      target: { value: 'PART_TIME' },
    });
    fireEvent.change(within(form).getByLabelText('Number of openings'), {
      target: { value: '2' },
    });
    fireEvent.change(within(form).getByLabelText('Closes on'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(within(form).getByLabelText('Pay range minimum'), {
      target: { value: '19.50' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create opening' }));
    await waitFor(() =>
      expect(api.createOpening).toHaveBeenCalledWith({
        organizationId: 'org-1',
        code: 'REQ-9',
        title: 'Lifeguard',
        employmentType: 'PART_TIME',
        description: null,
        positionId: null,
        organizationalUnitId: null,
        departmentId: null,
        teamId: null,
        workLocationId: null,
        hiringManagerEmployeeId: null,
        openingCount: 2,
        expectedStartDate: null,
        postedOn: null,
        closesOn: '2026-12-01',
        compensation: { payBasis: 'HOURLY', min: '19.50', max: null, currency: 'CAD' },
      }),
    );
    expect(await screen.findByText('Opening created as a draft.')).toBeInTheDocument();
  });

  it('adds an application for a new candidate from the pipeline', async () => {
    auth(['recruitment.manage']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [opening()] });
    api.stages.mockResolvedValue({ items: [] });
    api.applications.mockResolvedValue({
      items: [
        {
          id: 'app-1',
          status: 'ACTIVE',
          source: 'DIRECT',
          appliedAt: '2026-09-02T00:00:00.000Z',
          stageEnteredAt: '2026-09-10T00:00:00.000Z',
          candidate: { id: 'cand-1', displayName: 'Ada Lovelace', internal: false },
          opening: { id: 'op-1', code: 'REQ-1', title: 'Camp Counsellor', status: 'OPEN' },
          stage: { id: 's-2', name: 'Interview', kind: 'INTERVIEW', sortOrder: 2 },
          view: 'FULL',
        },
      ],
    });
    api.createApplication.mockResolvedValue({ id: 'app-2', candidateId: 'c-2', status: 'ACTIVE' });
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Pipeline' }));
    expect(
      await screen.findByRole('link', { name: 'Open application of Ada Lovelace' }),
    ).toHaveAttribute('href', '/recruitment/applications/app-1');
    const form = screen.getByRole('form', { name: 'Add application' });
    fireEvent.change(within(form).getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(within(form).getByLabelText('Last name'), { target: { value: 'Hopper' } });
    fireEvent.change(within(form).getByLabelText('Email'), {
      target: { value: 'grace@example.org' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add application' }));
    await waitFor(() =>
      expect(api.createApplication).toHaveBeenCalledWith({
        openingId: 'op-1',
        source: 'DIRECT',
        candidate: {
          firstName: 'Grace',
          lastName: 'Hopper',
          email: 'grace@example.org',
          phone: null,
          source: 'DIRECT',
        },
      }),
    );
  });

  it('refuses invalid submission JSON instead of importing nothing', async () => {
    auth(['recruitment.intake.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageIntake: true, canReadAllCandidates: false })],
    });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [opening()] });
    api.intake.mockResolvedValue({ items: [] });
    api.intakeSources.mockResolvedValue({
      items: [
        {
          id: 'src-1',
          organizationId: 'org-1',
          code: 'CAREERS',
          name: 'Careers form',
          provider: 'GOOGLE_FORMS',
          externalResourceId: 'form-1',
          resourceUrl: null,
          defaultOpeningId: null,
          lastSyncedAt: null,
          lastSyncStatus: null,
          lastSyncMessage: null,
          archivedAt: null,
          pendingOpening: 0,
        },
      ],
    });
    api.importSubmissions.mockResolvedValue({
      sourceId: 'src-1',
      received: 1,
      counts: { CREATED: 1 },
      outcomes: [],
    });
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Intake' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Import submissions into Careers form' }),
    );
    const form = screen.getByRole('form', { name: 'Import submissions' });
    const payload = within(form).getByLabelText(/Submissions/);

    fireEvent.change(payload, { target: { value: '{"externalResponseId": "r1"}' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Import' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('JSON array');
    expect(api.importSubmissions).not.toHaveBeenCalled();

    fireEvent.change(payload, { target: { value: '[{"externalResponseId": "r1"}]' } });
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importSubmissions).toHaveBeenCalledWith('src-1', [{ externalResponseId: 'r1' }]),
    );
    // Batch 7A: the report survives the refresh that follows the import.
    expect(await screen.findByText('Submissions imported.')).toBeInTheDocument();
    const report = await screen.findByRole('region', { name: 'Import report' });
    expect(report).toHaveTextContent('Careers form: 1 received: 1 created');
    await waitFor(() => expect(api.intakeSources).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: 'Import report' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss report' }));
    expect(screen.queryByRole('region', { name: 'Import report' })).not.toBeInTheDocument();
  });

  it('assigns a pending external submission to an opening', async () => {
    auth(['recruitment.intake.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageIntake: true, canReadAllCandidates: false })],
    });
    api.dashboard.mockResolvedValue(dashboard());
    api.intakeSources.mockResolvedValue({ items: [] });
    api.openings.mockResolvedValue({ items: [opening()] });
    api.intake.mockResolvedValue({
      items: [
        {
          id: 'sub-1',
          sourceId: 'src-1',
          externalResponseId: 'resp-1',
          status: 'PENDING_OPENING',
          reason: 'OPENING_NOT_FOUND',
          submission: {
            openingCode: 'REQ-404',
            candidate: { firstName: 'Mary', lastName: 'Jackson', email: 'mary@example.org' },
          },
          submittedAt: '2026-10-01T00:00:00.000Z',
          correctionCount: 0,
          candidateId: null,
          applicationId: null,
          receivedAt: '2026-10-01T00:00:00.000Z',
          lastReceivedAt: '2026-10-01T00:00:00.000Z',
          resolvedAt: null,
        },
      ],
      nextAfterId: null,
    });
    api.assignOpening.mockResolvedValue({});
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Intake' }));
    expect(await screen.findByText('Opening Not Found')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Opening for Mary Jackson'), {
      target: { value: 'op-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign Mary Jackson' }));
    await waitFor(() => expect(api.assignOpening).toHaveBeenCalledWith('sub-1', 'op-1'));
    expect(api.intake).toHaveBeenCalledWith('org-1', {
      status: 'PENDING_OPENING',
      sourceId: undefined,
      limit: 50,
    });
  });
});

describe('ApplicationPage', () => {
  it('offers the actions each offer status allows', async () => {
    api.application.mockResolvedValue(
      application({
        status: 'ACTIVE',
        offers: [
          offer({ id: 'of-draft', status: 'DRAFT', effectiveStatus: 'DRAFT' }),
          offer({ id: 'of-approved', status: 'APPROVED', effectiveStatus: 'APPROVED' }),
          offer({ id: 'of-sent', status: 'SENT', effectiveStatus: 'SENT' }),
          offer({ id: 'of-expired', status: 'SENT', effectiveStatus: 'EXPIRED' }),
          offer({ id: 'of-declined', status: 'DECLINED', effectiveStatus: 'DECLINED' }),
        ],
        actions: allowed({ canManage: true, canApproveOffer: true }),
      }),
    );
    api.offerAction.mockResolvedValue(offer());
    render(<ApplicationPage applicationId="app-1" />);
    const draft = await screen.findByRole('listitem', { name: 'Offer of-draft' });
    expect(within(draft).getByRole('button', { name: 'Approve offer' })).toBeInTheDocument();
    expect(within(draft).queryByRole('button', { name: 'Send offer' })).not.toBeInTheDocument();
    const approved = screen.getByRole('listitem', { name: 'Offer of-approved' });
    expect(within(approved).getByRole('button', { name: 'Send offer' })).toBeInTheDocument();
    expect(within(approved).getByRole('button', { name: 'Return to draft' })).toBeInTheDocument();
    const sent = screen.getByRole('listitem', { name: 'Offer of-sent' });
    expect(within(sent).getByRole('button', { name: 'Record acceptance' })).toBeInTheDocument();
    const expired = screen.getByRole('listitem', { name: 'Offer of-expired' });
    expect(within(expired).getByText('Expired')).toBeInTheDocument();
    expect(
      within(expired).queryByRole('button', { name: 'Record acceptance' }),
    ).not.toBeInTheDocument();
    expect(within(expired).getByRole('button', { name: 'Withdraw offer' })).toBeDisabled();
    const declined = screen.getByRole('listitem', { name: 'Offer of-declined' });
    expect(within(declined).queryAllByRole('button')).toHaveLength(0);

    fireEvent.click(within(sent).getByRole('button', { name: 'Record acceptance' }));
    await waitFor(() =>
      expect(api.offerAction).toHaveBeenCalledWith('of-sent', 'accept', undefined),
    );
    // A decline needs a reason.
    const decline = within(screen.getByRole('listitem', { name: 'Offer of-sent' })).getByRole(
      'button',
      { name: 'Record decline' },
    );
    expect(decline).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason \(required to record a decline/), {
      target: { value: 'Took another job' },
    });
    fireEvent.click(decline);
    await waitFor(() =>
      expect(api.offerAction).toHaveBeenCalledWith('of-sent', 'decline', 'Took another job'),
    );
  });

  it('hides offer approval without the approval permission and drafts an offer', async () => {
    api.application.mockResolvedValue(
      application({
        offers: [offer({ id: 'of-draft' })],
        actions: allowed({ canManage: true, canCreateOffer: false }),
      }),
    );
    render(<ApplicationPage applicationId="app-1" />);
    const draft = await screen.findByRole('listitem', { name: 'Offer of-draft' });
    expect(within(draft).queryByRole('button', { name: 'Approve offer' })).not.toBeInTheDocument();
    cleanup();
    api.application.mockResolvedValue(
      application({ actions: allowed({ canManage: true, canCreateOffer: true }) }),
    );
    api.createOffer.mockResolvedValue(offer());
    render(<ApplicationPage applicationId="app-1" />);
    const form = await screen.findByRole('form', { name: 'Draft offer' });
    // Prefilled with the opening's position, named — never shown as an id (Batch 7A).
    expect(within(form).getByRole('combobox', { name: /^Position/ })).toHaveValue(
      "The opening's position",
    );
    fireEvent.change(within(form).getByLabelText('Start date'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(within(form).getByLabelText('Rate amount'), { target: { value: '20.50' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Draft offer' }));
    await waitFor(() =>
      expect(api.createOffer).toHaveBeenCalledWith('app-1', {
        positionId: 'pos-1',
        employmentType: 'CASUAL',
        startDate: '2026-11-01',
        payBasis: 'HOURLY',
        rateAmount: '20.50',
        currency: 'CAD',
        expiresOn: null,
        candidateTerms: null,
        internalNotes: null,
      }),
    );
  });

  it('converts an accepted offer to an employee, confirming a new person on a possible match', async () => {
    const accepted = application({
      status: 'OFFERED',
      offers: [offer({ status: 'ACCEPTED', effectiveStatus: 'ACCEPTED' })],
      actions: allowed({ canManage: true, canHire: true }),
    });
    api.application.mockResolvedValue(accepted);
    api.hire
      .mockRejectedValueOnce(
        new AuthApiError(
          'conflict',
          409,
          'An employee with this email already exists. Choose that employee or confirm a new person.',
          {
            code: 'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE',
            matches: [{ employeeId: 'emp-7', employeeNumber: 'E-007', status: 'TERMINATED' }],
          },
        ),
      )
      .mockResolvedValueOnce({
        id: 'hire-1',
        personId: 'p-1',
        employeeId: 'emp-9',
        employmentAssignmentId: 'asg-9',
        compensationRecordId: 'comp-9',
        internalCandidate: false,
        createdEmployee: true,
        convertedByUserId: 'u-1',
        convertedAt: '2026-10-06T00:00:00.000Z',
        employeeNumber: 'E-100',
        assignment: { id: 'asg-9', status: 'ACTIVE', startDate: '2026-11-01' },
        opening: { id: 'op-1', status: 'OPEN', hiredCount: 2, openingCount: 3 },
      });
    render(<ApplicationPage applicationId="app-1" />);
    const form = await screen.findByRole('form', { name: 'Convert to employee' });
    // Pay group is the first picker; without a pay group search the ID is typed.
    fireEvent.click(within(form).getAllByRole('button', { name: 'Enter an ID instead' })[0]!);
    fireEvent.change(within(form).getByLabelText('Pay group ID'), {
      target: { value: 'pg-1' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Convert to employee' }));
    await waitFor(() =>
      expect(api.hire).toHaveBeenCalledWith('app-1', {
        isPrimary: true,
        initializeCompensation: true,
        payGroupId: 'pg-1',
        managerAssignmentId: null,
        existingEmployeeId: null,
      }),
    );
    expect(await screen.findByText('Employee E-007 (Terminated)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hire as employee E-007' })).toBeInTheDocument();
    api.application.mockResolvedValue({
      ...accepted,
      status: 'HIRED',
      hire: {
        id: 'hire-1',
        personId: 'p-1',
        employeeId: 'emp-9',
        employmentAssignmentId: 'asg-9',
        compensationRecordId: 'comp-9',
        internalCandidate: false,
        createdEmployee: true,
        convertedByUserId: 'u-1',
        convertedAt: '2026-10-06T00:00:00.000Z',
      },
      actions: allowed(),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new person' }));
    await waitFor(() =>
      expect(api.hire).toHaveBeenLastCalledWith('app-1', {
        isPrimary: true,
        initializeCompensation: true,
        payGroupId: 'pg-1',
        managerAssignmentId: null,
        existingEmployeeId: null,
        confirmNewPerson: true,
      }),
    );
    expect(await screen.findByText('Converted to employee E-100.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open employee record' })).toHaveAttribute(
      'href',
      '/admin/employees/emp-9',
    );
  });

  it('shows screening and records it as structured fields', async () => {
    api.application.mockResolvedValue(
      application({ actions: allowed({ canManage: true, canScreen: true }) }),
    );
    api.recordScreening.mockResolvedValue({});
    render(<ApplicationPage applicationId="app-1" />);
    const form = await screen.findByRole('form', { name: 'Screening form' });
    fireEvent.change(within(form).getByLabelText('Screening outcome'), {
      target: { value: 'ADVANCE' },
    });
    fireEvent.change(within(form).getByLabelText('Meets minimum qualifications'), {
      target: { value: 'yes' },
    });
    fireEvent.change(within(form).getByLabelText('Work authorization confirmed'), {
      target: { value: 'no' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save screening' }));
    await waitFor(() =>
      expect(api.recordScreening).toHaveBeenCalledWith('app-1', {
        outcome: 'ADVANCE',
        meetsMinimumQualifications: true,
        workAuthorizationConfirmed: false,
        requiredCertificationsHeld: null,
        availableFrom: null,
        notes: null,
      }),
    );
    expect(within(form).queryByText(/score/i)).not.toBeInTheDocument();
  });

  it('shows a hiring manager the pipeline and feedback but no screening or offers', async () => {
    const detail = application({ view: 'HIRING_MANAGER', actions: allowed() });
    delete detail.screening;
    delete detail.offers;
    api.application.mockResolvedValue(detail);
    render(<ApplicationPage applicationId="app-1" />);
    expect(await screen.findByText('Hiring manager view')).toBeInTheDocument();
    expect(screen.getByText(/Great with campers/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Screening' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Offers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Convert to employee' })).not.toBeInTheDocument();
    expect(screen.queryByText('ada@example.org')).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add document' })).not.toBeInTheDocument();
  });

  it('shows an interviewer only the candidate, opening, stage, documents and own interviews', async () => {
    const base = application();
    api.application.mockResolvedValue({
      id: base.id,
      view: 'INTERVIEWER',
      status: base.status,
      source: base.source,
      sourceDetail: null,
      appliedAt: base.appliedAt,
      stageEnteredAt: base.stageEnteredAt,
      stage: base.stage,
      organization: base.organization,
      opening: base.opening,
      candidate: { ...base.candidate, email: undefined, phone: undefined },
      interviews: base.interviews.map((interview) => ({ ...interview, isInterviewer: true })),
      documents: base.documents,
      actions: allowed(),
    } satisfies ApplicationDetail);
    render(<ApplicationPage applicationId="app-1" />);
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText(/Camp Counsellor \(REQ-1\)/)).toBeInTheDocument();
    expect(screen.getByText('Interview', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'My interviews' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Résumé' })).toBeInTheDocument();
    for (const name of ['Screening', 'Offers', 'Activity', 'Convert to employee']) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Candidate profile' })).not.toBeInTheDocument();
  });

  it('renders document links only for https URLs, opening them safely', async () => {
    api.application.mockResolvedValue(
      application({
        documents: [
          document({ id: 'd-1', title: 'Safe résumé', externalUrl: 'https://drive.example.com/1' }),
          document({ id: 'd-2', title: 'Plain http', externalUrl: 'http://example.com/cv.pdf' }),
          document({ id: 'd-3', title: 'Script link', externalUrl: 'javascript:alert(1)' }),
          document({
            id: 'd-4',
            title: 'Paper copy',
            provider: 'MANUAL_REFERENCE',
            externalUrl: null,
            externalFileId: 'Cabinet 3',
          }),
        ],
      }),
    );
    render(<ApplicationPage applicationId="app-1" />);
    const link = await screen.findByRole('link', { name: 'Safe résumé' });
    expect(link).toHaveAttribute('href', 'https://drive.example.com/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    for (const title of ['Plain http', 'Script link', 'Paper copy']) {
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: title })).not.toBeInTheDocument();
    }
  });

  it('rejects a non-https document link before sending it and removes a document with a reason', async () => {
    api.application.mockResolvedValue(application());
    api.removeDocument.mockResolvedValue(document());
    render(<ApplicationPage applicationId="app-1" />);
    const form = await screen.findByRole('form', { name: 'Add document' });
    fireEvent.change(within(form).getByLabelText('Document title'), { target: { value: 'CV' } });
    fireEvent.change(within(form).getByLabelText('Link (https)'), {
      target: { value: 'http://example.com/cv.pdf' },
    });
    expect(within(form).getByText('Document links must start with https://.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Add document' })).toBeDisabled();
    expect(api.addDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Résumé' }));
    fireEvent.change(screen.getByLabelText('Reason for removing'), {
      target: { value: 'Wrong file' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await waitFor(() => expect(api.removeDocument).toHaveBeenCalledWith('doc-1', 'Wrong file'));
  });

  it('schedules an interview with an ISO start and interviewer ids', async () => {
    api.application.mockResolvedValue(
      application({ actions: allowed({ canManage: true, canScheduleInterview: true }) }),
    );
    api.scheduleInterview.mockResolvedValue({});
    render(<ApplicationPage applicationId="app-1" />);
    const form = await screen.findByRole('form', { name: 'Schedule interview' });
    fireEvent.change(within(form).getByLabelText('Interview title'), {
      target: { value: 'Second interview' },
    });
    fireEvent.change(within(form).getByLabelText('Starts at'), {
      target: { value: '2026-10-10T09:30' },
    });
    // Batch 7A: interviewers come from the recruitment staff picker (no ids typed).
    api.options.mockResolvedValue({
      items: [
        { id: 'u-1', label: 'Sam Lee', description: 'E-001' },
        { id: 'u-2', label: 'Sam Park', description: 'E-002' },
      ],
      nextAfterId: null,
    });
    const picker = within(form).getByRole('combobox', { name: 'Add an interviewer' });
    for (const name of ['Sam Lee', 'Sam Park']) {
      fireEvent.change(picker, { target: { value: 'Sam' } });
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
    }
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'staff',
      expect.objectContaining({ search: 'Sam' }),
    );
    expect(within(form).queryByLabelText(/interviewer user IDs/)).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Schedule interview' }));
    await waitFor(() =>
      expect(api.scheduleInterview).toHaveBeenCalledWith('app-1', {
        type: 'VIDEO',
        title: 'Second interview',
        scheduledStart: new Date('2026-10-10T09:30').toISOString(),
        durationMinutes: 60,
        location: null,
        meetingUrl: null,
        interviewerUserIds: ['u-1', 'u-2'],
      }),
    );
  });

  it('shows a forbidden page without access', async () => {
    api.application.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<ApplicationPage applicationId="app-1" />);
    expect(
      await screen.findByText('You do not have access to this application.'),
    ).toBeInTheDocument();
  });
});

describe('CandidatePage', () => {
  it('shows the profile, applications and merges into another candidate', async () => {
    api.candidate.mockResolvedValue({
      ...application().candidate,
      applications: [
        {
          id: 'app-1',
          status: 'ACTIVE',
          opening: { id: 'op-1', code: 'REQ-1', title: 'Camp Counsellor', status: 'OPEN' },
          stage: { id: 's-2', name: 'Interview', kind: 'INTERVIEW' },
          appliedAt: '2026-09-02T00:00:00.000Z',
        },
      ],
      documents: [],
      activity: [],
      actions: { canEdit: true, canMerge: true, canMarkInternal: true },
    });
    api.mergeCandidate.mockResolvedValue({});
    render(<CandidatePage candidateId="cand-1" />);
    expect(await screen.findByRole('form', { name: 'Edit candidate' })).toBeInTheDocument();
    // Batch 10E-1: each application link names its opening.
    expect(
      screen.getByRole('link', { name: 'Open the application for Camp Counsellor' }),
    ).toHaveAttribute('href', '/recruitment/applications/app-1');
    const merge = screen.getByRole('region', { name: 'Merge or archive' });
    fireEvent.click(within(merge).getByRole('button', { name: 'Enter an ID instead' }));
    fireEvent.change(within(merge).getByLabelText('Candidate ID'), {
      target: { value: 'cand-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Merge candidate' }));
    await waitFor(() => expect(api.mergeCandidate).toHaveBeenCalledWith('cand-1', 'cand-2'));
  });

  it('marks an internal candidate from the recruitment employee picker (Batch 7A)', async () => {
    api.candidate.mockResolvedValue({
      ...application().candidate,
      applications: [],
      documents: [],
      activity: [],
      actions: { canEdit: true, canMerge: false, canMarkInternal: true },
    });
    api.setInternalEmployee.mockResolvedValue({});
    optionsByKind({
      hiringManager: [{ id: 'emp-4', label: 'Dorothy Vaughan', description: 'E-004' }],
    });
    render(<CandidatePage candidateId="cand-1" />);
    const section = await screen.findByRole('region', { name: 'Internal candidate' });
    await choose(section, 'Employee', 'Dor', /Dorothy Vaughan/);
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'hiringManager',
      expect.objectContaining({ search: 'Dor' }),
    );
    expect(within(section).queryByRole('button', { name: 'Enter an ID instead' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: /Mark as internal/ }));
    await waitFor(() => expect(api.setInternalEmployee).toHaveBeenCalledWith('cand-1', 'emp-4'));
  });
});

describe('MyInterviewsPage', () => {
  const mine = (overrides: Partial<MyInterview> = {}): MyInterview => ({
    ...application().interviews[0]!,
    status: 'COMPLETED',
    feedback: [],
    isInterviewer: true,
    candidate: { id: 'cand-1', displayName: 'Ada Lovelace' },
    opening: { id: 'op-1', code: 'REQ-1', title: 'Camp Counsellor' },
    stageName: 'Interview',
    myFeedback: null,
    ...overrides,
  });

  it('saves a draft and submits feedback', async () => {
    api.myInterviews.mockResolvedValue({ items: [mine()] });
    api.saveFeedback.mockResolvedValue({});
    api.submitFeedback.mockResolvedValue({});
    render(<MyInterviewsPage />);
    const form = await screen.findByRole('form', { name: 'Interview feedback' });
    fireEvent.change(within(form).getByLabelText('Recommendation'), {
      target: { value: 'YES' },
    });
    fireEvent.change(within(form).getByLabelText('Rating (1–5)'), { target: { value: '4' } });
    fireEvent.change(within(form).getByLabelText('Strengths'), {
      target: { value: 'Calm under pressure' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(api.saveFeedback).toHaveBeenCalledWith('int-1', {
        recommendation: 'YES',
        rating: 4,
        strengths: 'Calm under pressure',
        concerns: null,
        comments: null,
      }),
    );
    await screen.findByText('Draft saved.');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Interview feedback' })).getByRole('button', {
        name: 'Submit feedback',
      }),
    );
    await waitFor(() =>
      expect(api.submitFeedback).toHaveBeenCalledWith(
        'int-1',
        expect.objectContaining({ recommendation: 'YES', rating: 4 }),
      ),
    );
    expect(screen.getByRole('link', { name: 'Application and documents' })).toHaveAttribute(
      'href',
      '/recruitment/applications/app-1',
    );
  });

  it('shows submitted feedback read-only and locked', async () => {
    api.myInterviews.mockResolvedValue({
      items: [
        mine({
          myFeedback: {
            id: 'fb-1',
            interviewId: 'int-1',
            interviewerUserId: 'me',
            status: 'SUBMITTED',
            recommendation: 'STRONG_YES',
            rating: 5,
            strengths: 'Great with campers',
            concerns: null,
            comments: null,
            submittedAt: '2026-09-21T00:00:00.000Z',
            revision: 1,
            reopenReason: null,
            supersededAt: null,
          },
        }),
      ],
    });
    render(<MyInterviewsPage />);
    const locked = await screen.findByLabelText('My submitted feedback');
    expect(within(locked).getByText(/locked/)).toBeInTheDocument();
    expect(within(locked).getByText('Recommendation: Strong Yes')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Interview feedback' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit feedback' })).not.toBeInTheDocument();
  });
});

// ─── Batch 7A ───────────────────────────────────────────────────────────────

const page = (items: Array<Record<string, unknown>>) => ({ items, nextAfterId: null });

/** Answers GET /recruitment/options per kind. */
function optionsByKind(byKind: Record<string, Array<Record<string, unknown>>>) {
  api.options.mockImplementation((_org: string, kind: string) =>
    Promise.resolve(page(byKind[kind] ?? [])),
  );
}

async function choose(container: HTMLElement, name: string, search: string, option: RegExp) {
  fireEvent.change(within(container).getByRole('combobox', { name }), {
    target: { value: search },
  });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const submission = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  sourceId: 'src-1',
  externalResponseId: 'resp-1',
  status: 'PENDING_OPENING',
  reason: 'OPENING_NOT_FOUND',
  submission: {
    openingCode: 'REQ-404',
    candidate: { firstName: 'Mary', lastName: 'Jackson', email: 'mary@example.org' },
  },
  submittedAt: '2026-10-01T00:00:00.000Z',
  correctionCount: 0,
  candidateId: null,
  applicationId: null,
  receivedAt: '2026-10-01T00:00:00.000Z',
  lastReceivedAt: '2026-10-01T00:00:00.000Z',
  resolvedAt: null,
  ...overrides,
});

const source = (overrides: Record<string, unknown> = {}) => ({
  id: 'src-1',
  organizationId: 'org-1',
  code: 'CAREERS',
  name: 'Careers form',
  provider: 'GOOGLE_FORMS',
  externalResourceId: 'form-1',
  resourceUrl: null,
  defaultOpeningId: null,
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncMessage: null,
  archivedAt: null,
  pendingOpening: 0,
  ...overrides,
});

describe('Batch 7A — recruitment without raw ids', () => {
  it('creates an opening from pickers only; a team carries its department and unit', async () => {
    auth(['recruitment.read', 'recruitment.manage']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [] });
    api.createOpening.mockResolvedValue(opening({ id: 'op-9', status: 'DRAFT' }));
    optionsByKind({
      team: [
        {
          id: 'team-a',
          label: 'Team A',
          description: 'TA',
          placement: { organizationalUnitId: 'unit-1', departmentId: 'dept-a', teamId: 'team-a' },
        },
      ],
      workLocation: [{ id: 'wl-1', label: 'Toronto campus', description: 'TOR' }],
      hiringManager: [{ id: 'emp-2', label: 'Grace Hopper', description: 'E-002' }],
    });
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Openings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New opening' }));
    const form = screen.getByRole('form', { name: 'Create opening' });
    // No raw-id text field remains.
    expect(within(form).queryByLabelText(/ ID/)).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Requisition code'), {
      target: { value: 'REQ-T' },
    });
    fireEvent.change(within(form).getByLabelText('Job title'), {
      target: { value: 'Assistant' },
    });
    expect(within(form).getByLabelText('Placed in')).toHaveValue('team');
    await choose(form, 'Team (optional)', 'Team', /Team A/);
    expect(within(form).getByRole('combobox', { name: 'Team (optional)' })).toHaveValue('Team A');
    await choose(form, 'Work location (optional)', 'Tor', /Toronto campus/);
    await choose(form, 'Hiring manager (optional)', 'Grace', /Grace Hopper/);
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'hiringManager',
      expect.objectContaining({ search: 'Grace' }),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Create opening' }));
    await waitFor(() =>
      expect(api.createOpening).toHaveBeenCalledWith(
        expect.objectContaining({
          positionId: null,
          organizationalUnitId: 'unit-1',
          departmentId: 'dept-a',
          teamId: 'team-a',
          workLocationId: 'wl-1',
          hiringManagerEmployeeId: 'emp-2',
        }),
      ),
    );
  });

  it('edits an opening showing names, never ids, and shows its details and history', async () => {
    auth(['recruitment.read', 'recruitment.manage']);
    const existing = opening({
      position: null,
      department: { id: 'dept-a', name: 'Aquatics' },
      workLocation: { id: 'wl-1', name: 'Toronto campus' },
      hiringManager: { id: 'emp-2', displayName: 'Grace Hopper' },
    });
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [existing] });
    api.opening.mockResolvedValue({
      ...existing,
      events: [
        {
          id: 'ev-1',
          type: 'STATUS_CHANGED',
          fromStatus: 'DRAFT',
          toStatus: 'OPEN',
          changedFields: null,
          reason: null,
          actorUserId: 'u-1',
          createdAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    });
    api.updateOpening.mockResolvedValue(existing);
    optionsByKind({});
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Openings' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Details of Camp Counsellor' }));
    const details = await screen.findByRole('region', { name: 'Opening details' });
    expect(api.opening).toHaveBeenCalledWith('op-1');
    // Wait for the details to load (the panel shows its loading state first).
    expect(await within(details).findByText('Aquatics')).toBeInTheDocument();
    expect(within(details).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(details).getByRole('list', { name: 'Opening history' })).toHaveTextContent(
      'Open',
    );
    fireEvent.click(within(details).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('region', { name: 'Opening details' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Camp Counsellor' }));
    const form = screen.getByRole('form', { name: 'Edit opening' });
    expect(within(form).getByLabelText('Placed in')).toHaveValue('department');
    expect(within(form).getByRole('combobox', { name: 'Department (optional)' })).toHaveValue(
      'Aquatics',
    );
    expect(within(form).getByRole('combobox', { name: 'Work location (optional)' })).toHaveValue(
      'Toronto campus',
    );
    expect(within(form).getByRole('combobox', { name: 'Hiring manager (optional)' })).toHaveValue(
      'Grace Hopper',
    );
    expect(form).not.toHaveTextContent('dept-a');
    fireEvent.click(within(form).getByRole('button', { name: 'Save opening' }));
    await waitFor(() =>
      expect(api.updateOpening).toHaveBeenCalledWith(
        'op-1',
        expect.objectContaining({
          departmentId: 'dept-a',
          workLocationId: 'wl-1',
          hiringManagerEmployeeId: 'emp-2',
        }),
      ),
    );
  });

  it('confirms cancelling an opening, with the required reason', async () => {
    auth(['recruitment.manage']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [opening()] });
    api.transitionOpening.mockResolvedValue(opening({ status: 'CANCELLED' }));
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Openings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Camp Counsellor' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel Camp Counsellor?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.transitionOpening).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Camp Counsellor' }));
    const again = await screen.findByRole('alertdialog', { name: 'Cancel Camp Counsellor?' });
    fireEvent.change(within(again).getByLabelText('Reason'), {
      target: { value: 'Funding withdrawn' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel opening' }));
    await waitFor(() =>
      expect(api.transitionOpening).toHaveBeenCalledWith('op-1', 'cancel', 'Funding withdrawn'),
    );
  });

  it('pages intake history by status and source, edits a source and confirms a rejection', async () => {
    auth(['recruitment.intake.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageIntake: true, canReadAllCandidates: false })],
    });
    api.dashboard.mockResolvedValue(dashboard());
    api.openings.mockResolvedValue({ items: [opening()] });
    api.intakeSources.mockResolvedValue({
      items: [source(), source({ id: 'src-2', name: 'Old form', archivedAt: '2026-01-01' })],
    });
    api.intake.mockImplementation((_org: string, filters: { status: string; afterId?: string }) => {
      if (filters.status === 'PENDING_OPENING')
        return Promise.resolve({ items: [submission()], nextAfterId: null });
      return Promise.resolve(
        filters.afterId
          ? {
              items: [
                submission({
                  id: 'sub-3',
                  status: 'REJECTED',
                  reason: 'Duplicate',
                  submission: { candidate: { firstName: 'Old', lastName: 'One' } },
                }),
              ],
              nextAfterId: null,
            }
          : {
              items: [
                submission({
                  id: 'sub-2',
                  status: 'APPLIED',
                  applicationId: 'app-7',
                  resolvedAt: '2026-10-02T00:00:00.000Z',
                }),
              ],
              nextAfterId: 'sub-2',
            },
      );
    });
    api.rejectSubmission.mockResolvedValue({});
    api.updateIntakeSource.mockResolvedValue(source());
    render(<RecruitmentAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Intake' }));

    // Rejecting from the queue is confirmed, with a reason.
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Mary Jackson' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Reject the submission from Mary Jackson?',
    });
    expect(within(dialog).getByRole('button', { name: 'Reject submission' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Spam' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject submission' }));
    await waitFor(() => expect(api.rejectSubmission).toHaveBeenCalledWith('sub-1', 'Spam'));

    // History: applied submissions link to their application; "Load more" appends the next page.
    fireEvent.change(await screen.findByLabelText('Submission status'), {
      target: { value: 'APPLIED' },
    });
    expect(await screen.findByRole('link', { name: 'Open application' })).toHaveAttribute(
      'href',
      '/recruitment/applications/app-7',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more submissions' }));
    expect(await screen.findByText('Old One')).toBeInTheDocument();
    expect(api.intake).toHaveBeenLastCalledWith('org-1', {
      status: 'APPLIED',
      sourceId: undefined,
      limit: 50,
      afterId: 'sub-2',
    });
    // Archived sources stay filterable.
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'src-2' } });
    await waitFor(() =>
      expect(api.intake).toHaveBeenLastCalledWith('org-1', {
        status: 'APPLIED',
        sourceId: 'src-2',
        limit: 50,
      }),
    );

    // Editing a source: name, link and default opening.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Careers form' }));
    const editor = screen.getByRole('form', { name: 'Edit Careers form' });
    fireEvent.change(within(editor).getByLabelText('Form link (https)'), {
      target: { value: 'http://insecure.example' },
    });
    expect(within(editor).getByRole('alert')).toHaveTextContent('https://');
    fireEvent.change(within(editor).getByLabelText('Form link (https)'), {
      target: { value: 'https://forms.example/careers' },
    });
    fireEvent.change(within(editor).getByLabelText('Default opening'), {
      target: { value: 'op-1' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save source' }));
    await waitFor(() =>
      expect(api.updateIntakeSource).toHaveBeenCalledWith('src-1', {
        name: 'Careers form',
        resourceUrl: 'https://forms.example/careers',
        defaultOpeningId: 'op-1',
      }),
    );
  });
});

describe('Batch 7A — application page', () => {
  const scheduled = () =>
    application({
      actions: allowed({
        canManage: true,
        canScheduleInterview: true,
        canWithdraw: true,
        canReject: true,
      }),
      interviews: [
        {
          ...application().interviews[0]!,
          status: 'SCHEDULED',
          completedAt: null,
          feedback: [],
          interviewers: [{ userId: 'u-9', email: 'grace@example.org', feedbackSubmitted: false }],
        },
      ],
    });

  it('reschedules an interview and shows its feedback history', async () => {
    api.application.mockResolvedValue(scheduled());
    api.rescheduleInterview.mockResolvedValue({});
    api.feedbackHistory.mockResolvedValue({
      items: [
        {
          ...application().interviews[0]!.feedback[0]!,
          revision: 1,
          supersededAt: '2026-09-22T00:00:00.000Z',
        },
        {
          ...application().interviews[0]!.feedback[0]!,
          id: 'fb-2',
          revision: 2,
          status: 'SUBMITTED',
          reopenReason: 'Clarify rating',
        },
      ],
    });
    render(<ApplicationPage applicationId="app-1" />);
    const card = await screen.findByRole('listitem', { name: 'Interview Panel interview' });
    fireEvent.click(within(card).getByRole('button', { name: 'Feedback history' }));
    const history = await within(card).findByRole('region', {
      name: 'Feedback history of Panel interview',
    });
    expect(api.feedbackHistory).toHaveBeenCalledWith('int-1');
    expect(history).toHaveTextContent('Revision 1');
    expect(history).toHaveTextContent('Superseded');
    expect(history).toHaveTextContent('Reopened: Clarify rating');

    fireEvent.click(within(card).getByRole('button', { name: 'Reschedule' }));
    const form = within(card).getByRole('form', { name: 'Reschedule Panel interview' });
    fireEvent.change(within(form).getByLabelText('New start'), {
      target: { value: '2026-09-25T10:00' },
    });
    fireEvent.change(within(form).getByLabelText('New duration (minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save new time' }));
    await waitFor(() =>
      expect(api.rescheduleInterview).toHaveBeenCalledWith('int-1', {
        scheduledStart: new Date('2026-09-25T10:00').toISOString(),
        durationMinutes: 30,
        location: null,
        meetingUrl: 'https://meet.example.com/abc',
      }),
    );
  });

  it('confirms cancelling an interview and closing the application, each with a reason', async () => {
    api.application.mockResolvedValue(scheduled());
    api.cancelInterview.mockResolvedValue({});
    api.withdraw.mockResolvedValue({});
    render(<ApplicationPage applicationId="app-1" />);
    const card = await screen.findByRole('listitem', { name: 'Interview Panel interview' });
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel interview' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel Panel interview?' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Candidate rescheduled' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel interview' }));
    await waitFor(() =>
      expect(api.cancelInterview).toHaveBeenCalledWith('int-1', 'Candidate rescheduled'),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw application' }));
    const withdraw = await screen.findByRole('alertdialog', {
      name: "Withdraw Ada Lovelace's application?",
    });
    fireEvent.change(within(withdraw).getByLabelText('Reason'), {
      target: { value: 'Took another job' },
    });
    fireEvent.click(within(withdraw).getByRole('button', { name: 'Withdraw application' }));
    await waitFor(() => expect(api.withdraw).toHaveBeenCalledWith('app-1', 'Took another job'));
  });

  it('adds an interviewer from the staff picker and picks the hire manager by name', async () => {
    api.application.mockResolvedValue(scheduled());
    api.addInterviewer.mockResolvedValue({});
    optionsByKind({ staff: [{ id: 'u-3', label: 'Ken Thompson', description: 'E-003' }] });
    render(<ApplicationPage applicationId="app-1" />);
    const card = await screen.findByRole('listitem', { name: 'Interview Panel interview' });
    await choose(card, 'Add interviewer to Panel interview', 'Ken', /Ken Thompson/);
    expect(within(card).queryByRole('button', { name: 'Enter an ID instead' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Add interviewer' }));
    await waitFor(() => expect(api.addInterviewer).toHaveBeenCalledWith('int-1', 'u-3'));
  });

  it('offers a manager picker instead of a manager assignment ID field', async () => {
    api.application.mockResolvedValue(
      application({
        status: 'OFFERED',
        offers: [offer({ status: 'ACCEPTED', effectiveStatus: 'ACCEPTED' })],
        actions: allowed({ canManage: true, canHire: true }),
      }),
    );
    render(<ApplicationPage applicationId="app-1" />);
    const form = await screen.findByRole('form', { name: 'Convert to employee' });
    expect(within(form).queryByLabelText('Manager assignment ID (optional)')).toBeNull();
    expect(
      within(form).getByRole('combobox', { name: /Manager \(optional\) — employee/ }),
    ).toBeInTheDocument();
  });
});
