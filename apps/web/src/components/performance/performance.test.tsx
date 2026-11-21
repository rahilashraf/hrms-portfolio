import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { Evidence, Goal, ReviewDetail } from '../../lib/performance/types';
import { EmployeePerformanceSection } from './employee-performance-section';
import { MyPerformancePage } from './my-performance-page';
import { PerformanceAdminPage } from './performance-admin-page';
import { ReviewPage } from './review-page';

const mocks = vi.hoisted(() => ({
  api: {
    me: vi.fn(),
    myReviews: vi.fn(),
    myGoals: vi.fn(),
    myEvidence: vi.fn(),
    reviewing: vi.fn(),
    review: vi.fn(),
    saveAnswers: vi.fn(),
    submit: vi.fn(),
    reassign: vi.fn(),
    reopen: vi.fn(),
    finalize: vi.fn(),
    acknowledge: vi.fn(),
    closeReview: vi.fn(),
    correct: vi.fn(),
    linkEvidence: vi.fn(),
    unlinkEvidence: vi.fn(),
    linkGoal: vi.fn(),
    unlinkGoal: vi.fn(),
    employeeReviews: vi.fn(),
    employeeGoals: vi.fn(),
    employeeEvidence: vi.fn(),
    createGoal: vi.fn(),
    updateGoal: vi.fn(),
    organizations: vi.fn(),
    options: vi.fn(),
    competencies: vi.fn(),
    createCompetency: vi.fn(),
    archiveCompetency: vi.fn(),
    scales: vi.fn(),
    createScale: vi.fn(),
    transitionScale: vi.fn(),
    templates: vi.fn(),
    template: vi.fn(),
    createTemplate: vi.fn(),
    transitionTemplate: vi.fn(),
    copyTemplate: vi.fn(),
    cycles: vi.fn(),
    createCycle: vi.fn(),
    cycleReviews: vi.fn(),
    addReviews: vi.fn(),
    transitionCycle: vi.fn(),
    closeCycle: vi.fn(),
    attention: vi.fn(),
    evidenceSources: vi.fn(),
    createEvidenceSource: vi.fn(),
    importResults: vi.fn(),
    intake: vi.fn(),
    resolveIntake: vi.fn(),
    withdrawEvidence: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/performance/api', () => ({ performanceApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const quiz = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: 'ev-1',
  organizationId: 'org-1',
  employmentAssignment: null,
  provider: 'GOOGLE_FORMS',
  kind: 'ASSESSMENT',
  channel: 'SYNC',
  title: 'Staff Code of Conduct Quiz 2026',
  sourceName: 'Code of Conduct quiz',
  completedAt: '2026-09-01T14:30:00.000Z',
  score: '17.00',
  maxScore: '20.00',
  percentage: '85.00',
  passed: true,
  passThresholdPercent: '80.00',
  status: 'ACTIVE',
  withdrawalReason: null,
  revision: 1,
  importedAt: '2026-09-01T15:00:00.000Z',
  sync: { lastSyncedAt: '2026-09-01T15:00:00.000Z', lastSyncStatus: 'OK' },
  ...overrides,
});

const LEVELS = [
  { value: 1, label: 'Needs Improvement', description: null },
  { value: 3, label: 'Meets Expectations', description: null },
  { value: 5, label: 'Exceptional', description: null },
];

const allowed = (overrides: Partial<ReviewDetail['actions']> = {}): ReviewDetail['actions'] => ({
  canEditSelf: false,
  canEditReviewer: false,
  canReassign: false,
  canReopenSelf: false,
  canReopenReviewer: false,
  canLinkEvidence: false,
  canLinkGoals: false,
  canFinalize: false,
  canAcknowledge: false,
  canClose: false,
  canCorrect: false,
  ...overrides,
});

const review = (overrides: Partial<ReviewDetail> = {}): ReviewDetail => ({
  id: 'rev-1',
  status: 'IN_PROGRESS',
  selfStatus: 'IN_PROGRESS',
  reviewerStatus: 'NOT_STARTED',
  viewer: 'SELF',
  cycle: {
    id: 'cyc-1',
    code: 'ANNUAL-2026',
    name: 'Annual review 2026',
    status: 'OPEN',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    windowStart: '2026-11-01',
    windowEnd: '2026-12-15',
    selfReviewDueDate: '2026-11-10',
    reviewerDueDate: '2026-12-01',
    scoringMode: 'WEIGHTED_AVERAGE',
    overallRatingEnabled: true,
    overallScaleLevels: LEVELS,
    acknowledgementEnabled: true,
  },
  organization: { id: 'org-1', name: 'Harbourline' },
  employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
  employmentAssignment: { id: 'asg-1', positionName: 'Grade 3 Teacher' },
  reviewer: { id: 'emp-2', displayName: 'Grace Hopper' },
  form: [
    {
      id: 'sec-1',
      title: 'Competencies',
      description: null,
      items: [
        {
          id: 'item-comm',
          sortOrder: 1,
          itemType: 'RATING',
          prompt: 'Communication',
          helpText: null,
          respondent: 'BOTH',
          required: true,
          weight: '60.00',
          competency: { id: 'c-1', code: 'COMM', name: 'Communication' },
          scaleLevels: LEVELS,
          scaleMin: null,
          scaleMax: null,
        },
        {
          id: 'item-rel',
          sortOrder: 2,
          itemType: 'RATING',
          prompt: 'Classroom management',
          helpText: null,
          respondent: 'REVIEWER',
          required: false,
          weight: '40.00',
          competency: null,
          scaleLevels: LEVELS,
          scaleMin: null,
          scaleMax: null,
        },
      ],
    },
  ],
  responses: {},
  goals: [],
  evidence: [],
  calculatedScore: null,
  overallRating: null,
  finalizedAt: null,
  acknowledgedAt: null,
  closedAt: null,
  closeReason: null,
  acknowledgement: null,
  events: [],
  actions: allowed({ canEditSelf: true }),
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReset();
});

// Batch 10E-2: tab clicks now write the section into the URL (#hash); every test starts from a
// clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const goal = (overrides: Partial<Goal> = {}): Goal =>
  ({
    id: 'goal-1',
    organizationId: 'org-1',
    employmentAssignmentId: 'asg-1',
    positionName: 'Grade 3 Teacher',
    title: 'Mentor a new teacher',
    description: null,
    measure: null,
    startDate: '2026-01-15',
    dueDate: null,
    status: 'IN_PROGRESS',
    progressPercent: 20,
    completionNotes: null,
    cancellationReason: null,
    setBy: 'MANAGER',
    createdBy: { userId: 'u-2', displayName: 'Grace Hopper' },
    ...overrides,
  }) as Goal;

describe('MyPerformancePage', () => {
  const load = (queue: unknown[] = []) => {
    api.me.mockResolvedValue({
      employeeId: 'emp-1',
      assignments: [
        {
          id: 'asg-1',
          status: 'ACTIVE',
          isPrimary: true,
          positionName: 'Grade 3 Teacher',
          organization: { id: 'org-1', name: 'Harbourline' },
        },
      ],
    });
    api.myReviews.mockResolvedValue({
      items: [
        {
          id: 'rev-1',
          cycle: {
            id: 'c',
            code: 'A',
            name: 'Annual review 2026',
            status: 'OPEN',
            periodStart: '2026-01-01',
            periodEnd: '2026-12-31',
          },
          positionName: 'Grade 3 Teacher',
          reviewer: null,
          status: 'FINALIZED',
          selfStatus: 'SUBMITTED',
          reviewerStatus: 'SUBMITTED',
          overallRating: { value: 4, label: 'Exceeds Expectations' },
          calculatedScore: '3.60',
          finalizedAt: '2026-12-01T00:00:00.000Z',
          acknowledgedAt: null,
          closeReason: null,
          awaitingAcknowledgement: true,
        },
      ],
    });
    api.myGoals.mockResolvedValue({ items: [] });
    api.myEvidence.mockResolvedValue({
      items: [
        quiz(),
        quiz({
          id: 'ev-2',
          title: 'Fire safety',
          score: null,
          maxScore: null,
          percentage: null,
          passed: null,
        }),
      ],
    });
    api.reviewing.mockResolvedValue({ items: queue });
  };

  it('shows reviews, Google Forms quiz results and adds a goal in a dialog', async () => {
    load();
    api.createGoal.mockResolvedValue(goal({ setBy: 'EMPLOYEE' }));
    render(<MyPerformancePage />);
    expect(await screen.findByText('Annual review 2026')).toBeInTheDocument();
    expect(screen.getByText('4 — Exceeds Expectations')).toBeInTheDocument();
    expect(screen.getByText('Please acknowledge')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Open .* review$/ })).toHaveAttribute(
      'href',
      '/performance/reviews/rev-1',
    );
    // No reviews to write: no such tab.
    expect(screen.queryByRole('tab', { name: /Reviews to write/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Assessments & training' }));
    expect(await screen.findByText('Staff Code of Conduct Quiz 2026')).toBeInTheDocument();
    expect(screen.getByText('17.00 / 20.00 (85.00%) · Passed')).toBeInTheDocument();
    expect(screen.getByText('Completed (not graded)')).toBeInTheDocument();
    expect(screen.getAllByText('Google Forms')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: 'My goals' }));
    expect(await screen.findByText('You have no goals yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a goal' });
    fireEvent.change(within(dialog).getByLabelText('Goal'), {
      target: { value: 'Run the science fair' },
    });
    fireEvent.change(within(dialog).getByLabelText('Start date'), {
      target: { value: '2026-01-15' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set goal' }));
    await waitFor(() =>
      expect(api.createGoal).toHaveBeenCalledWith({
        employmentAssignmentId: 'asg-1',
        title: 'Run the science fair',
        description: null,
        measure: null,
        startDate: '2026-01-15',
        dueDate: null,
        progressPercent: null,
      }),
    );
    await waitFor(() => expect(api.myGoals).toHaveBeenCalledTimes(2));
  });

  it('keeps the other sections when one fails, and retries the failed one', async () => {
    load();
    api.myReviews.mockRejectedValueOnce(new AuthApiError('unexpected', 500));
    render(<MyPerformancePage />);
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Your reviews could not be loaded.');
    // Never a false "no reviews".
    expect(screen.queryByText('You have no performance reviews yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Assessments & training' }));
    expect(await screen.findByText('Staff Code of Conduct Quiz 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'My reviews' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry your reviews' }));
    expect(await screen.findByText('Annual review 2026')).toBeInTheDocument();
    expect(api.myReviews).toHaveBeenCalledTimes(2);
  });

  it('shows who set each goal and leaves completing a manager-set goal to the manager', async () => {
    load();
    api.myGoals.mockResolvedValue({
      items: [
        goal(),
        goal({ id: 'goal-2', title: 'Read two books', setBy: 'EMPLOYEE', createdBy: null }),
      ],
    });
    api.updateGoal.mockResolvedValue(goal({ id: 'goal-2', status: 'COMPLETED' }));
    render(<MyPerformancePage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'My goals' }));
    const table = await screen.findByRole('region', { name: 'Your goals' });
    expect(within(table).getByText('Set by your manager (Grace Hopper)')).toBeInTheDocument();
    expect(within(table).getByText('Set by you')).toBeInTheDocument();
    expect(
      within(table).queryByRole('button', { name: 'Complete Mentor a new teacher' }),
    ).not.toBeInTheDocument();
    expect(
      within(table).getByText('Your manager or HR completes or cancels this goal.'),
    ).toBeInTheDocument();
    // Their own goal: completed after confirmation, with optional notes.
    fireEvent.click(within(table).getByRole('button', { name: 'Complete Read two books' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Complete “Read two books”?' });
    fireEvent.change(within(dialog).getByLabelText(/Completion notes/), {
      target: { value: 'Both done' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Complete goal' }));
    await waitFor(() =>
      expect(api.updateGoal).toHaveBeenCalledWith('goal-2', {
        status: 'COMPLETED',
        completionNotes: 'Both done',
      }),
    );
  });

  it('shows the API message when a goal under review cannot be edited', async () => {
    load();
    api.myGoals.mockResolvedValue({ items: [goal({ setBy: 'EMPLOYEE', createdBy: null })] });
    api.updateGoal.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The goal is linked to a review that is being written.', {
        code: 'PERFORMANCE_GOAL_UNDER_REVIEW',
      }),
    );
    render(<MyPerformancePage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'My goals' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Mentor a new teacher' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit “Mentor a new teacher”' });
    fireEvent.change(within(dialog).getByLabelText('Progress (%)'), { target: { value: '50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save goal' }));
    expect(
      await within(dialog).findByText('The goal is linked to a review that is being written.'),
    ).toBeInTheDocument();
  });

  it('lists the reviews the employee writes as a reviewer', async () => {
    load([
      {
        id: 'rev-9',
        cycle: {
          id: 'c',
          name: 'Annual review 2026',
          reviewerDueDate: '2026-12-01',
          windowEnd: '2026-12-15',
        },
        employee: { id: 'emp-3', employeeNumber: 'E-3', displayName: 'Alan Turing' },
        positionName: 'Grade 4 Teacher',
        status: 'NOT_STARTED',
        selfStatus: 'NOT_STARTED',
        reviewerStatus: 'NOT_STARTED',
        overdue: ['REVIEWER'],
      },
    ]);
    render(<MyPerformancePage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reviews to write (1)' }));
    expect(screen.getByRole('link', { name: 'Write review' })).toHaveAttribute(
      'href',
      '/performance/reviews/rev-9',
    );
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('explains when the account is not linked to an employee', async () => {
    load();
    api.me.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'PERFORMANCE_NOT_AN_EMPLOYEE' }),
    );
    render(<MyPerformancePage />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('says when Performance is switched off, and when access is refused', async () => {
    load();
    api.me.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'FEATURE_DISABLED' }),
    );
    render(<MyPerformancePage />);
    expect(await screen.findByText(/Performance is switched off/)).toBeInTheDocument();
    cleanup();
    load();
    api.myEvidence.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<MyPerformancePage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Assessments & training' }));
    expect(
      await screen.findByText('You do not have access to your assessments.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });
});

describe('ReviewPage', () => {
  it('lets the employee answer only their items, save and submit after confirming', async () => {
    api.review.mockResolvedValue(review());
    api.saveAnswers.mockResolvedValue(review());
    api.submit.mockResolvedValue(review({ selfStatus: 'SUBMITTED', actions: allowed() }));
    render(<ReviewPage reviewId="rev-1" />);
    const form = await screen.findByRole('form', { name: 'Review form' });
    // Only the shared item is editable (the reviewer-only one has no input for the employee).
    expect(within(form).getAllByLabelText(/ rating$/)).toHaveLength(1);
    fireEvent.change(within(form).getByLabelText('Communication rating'), {
      target: { value: '5' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(api.saveAnswers).toHaveBeenCalledWith('rev-1', 'self', {
        answers: [
          {
            itemId: 'item-comm',
            ratingValue: 5,
            numericValue: null,
            booleanValue: null,
            textValue: null,
          },
        ],
      }),
    );
    expect(screen.queryByLabelText('Overall rating')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Submit self review' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Submit your self review?' });
    expect(api.submit).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: /Submit/ }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith('rev-1', 'self'));
    expect(screen.queryByRole('region', { name: 'HR actions' })).not.toBeInTheDocument();
  });

  it('shows the finalized outcome and records an acknowledgement with a comment', async () => {
    const finalized = review({
      status: 'FINALIZED',
      selfStatus: 'SUBMITTED',
      reviewerStatus: 'SUBMITTED',
      overallRating: { value: 3, label: 'Meets Expectations' },
      calculatedScore: '3.40',
      finalizedAt: '2026-12-02T00:00:00.000Z',
      evidence: [
        {
          linkId: 'l-1',
          formItemId: null,
          evidenceId: 'ev-1',
          title: 'Staff Code of Conduct Quiz 2026',
          provider: 'GOOGLE_FORMS',
          completedAt: '2026-09-01T14:30:00.000Z',
          score: '17.00',
          maxScore: '20.00',
          percentage: '85.00',
          passed: true,
          status: 'ACTIVE',
          changedSinceLinked: true,
        },
      ],
      actions: allowed({ canAcknowledge: true }),
    });
    api.review.mockResolvedValue(finalized);
    api.acknowledge.mockResolvedValue({ ...finalized, status: 'ACKNOWLEDGED', actions: allowed() });
    render(<ReviewPage reviewId="rev-1" />);
    expect(await screen.findByText('3 — Meets Expectations')).toBeInTheDocument();
    expect(screen.getByText('Corrected since it was linked')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Acknowledge review' });
    fireEvent.change(within(form).getByLabelText('Comment (optional)'), {
      target: { value: 'I would like more coaching.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(api.acknowledge).toHaveBeenCalledWith('rev-1', 'I would like more coaching.'),
    );
  });

  it('confirms HR finalization and asks each reopen for its own reason', async () => {
    const submitted = review({
      viewer: 'HR',
      status: 'SUBMITTED',
      reviewerStatus: 'SUBMITTED',
      actions: allowed({ canFinalize: true, canReopenReviewer: true, canClose: true }),
    });
    api.review.mockResolvedValue(submitted);
    api.finalize.mockResolvedValue({ ...submitted, status: 'FINALIZED', actions: allowed() });
    api.reopen.mockResolvedValue(submitted);
    render(<ReviewPage reviewId="rev-1" />);
    const actions = await screen.findByRole('region', { name: 'HR actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Reopen reviewer review' }));
    const reopen = await screen.findByRole('alertdialog', {
      name: 'Reopen the reviewer review?',
    });
    const confirmReopen = within(reopen).getByRole('button', { name: 'Reopen reviewer review' });
    expect(confirmReopen).toBeDisabled();
    fireEvent.change(within(reopen).getByLabelText(/Why is the reviewer review reopened/), {
      target: { value: 'Missing comments' },
    });
    fireEvent.click(confirmReopen);
    await waitFor(() =>
      expect(api.reopen).toHaveBeenCalledWith('rev-1', 'REVIEWER', 'Missing comments'),
    );
    // Finalizing shares the review with the employee: confirmed first, nothing sent on Cancel.
    fireEvent.click(within(actions).getByRole('button', { name: 'Finalize' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Finalize this review?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.finalize).not.toHaveBeenCalled();
    fireEvent.click(within(actions).getByRole('button', { name: 'Finalize' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Finalize review',
      }),
    );
    await waitFor(() => expect(api.finalize).toHaveBeenCalledWith('rev-1'));
  });

  it('closes an unfinished review only after confirmation with a required reason', async () => {
    const open = review({
      viewer: 'HR',
      status: 'IN_PROGRESS',
      actions: allowed({ canClose: true }),
    });
    api.review.mockResolvedValue(open);
    api.closeReview.mockResolvedValue({ ...open, status: 'CLOSED', actions: allowed() });
    render(<ReviewPage reviewId="rev-1" />);
    const actions = await screen.findByRole('region', { name: 'HR actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Close review' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close this review?' });
    const confirm = within(dialog).getByRole('button', { name: 'Close review' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Why is the unfinished review closed/), {
      target: { value: 'Left the organization' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.closeReview).toHaveBeenCalledWith('rev-1', 'Left the organization'),
    );
  });

  it('changes the reviewer by name and removes one only after confirmation', async () => {
    const open = review({ viewer: 'HR', actions: allowed({ canReassign: true }) });
    api.review.mockResolvedValue(open);
    api.reassign.mockResolvedValue(open);
    api.options.mockResolvedValue({
      items: [{ id: 'emp-7', label: 'Katherine Johnson', description: 'E-7' }],
      nextAfterId: null,
    });
    render(<ReviewPage reviewId="rev-1" />);
    const actions = await screen.findByRole('region', { name: 'HR actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Change reviewer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change reviewer' });
    const picker = within(dialog).getByRole('combobox', { name: /New reviewer/ });
    fireEvent.focus(picker);
    fireEvent.click(await within(dialog).findByRole('option', { name: /Katherine Johnson/ }));
    expect(api.options).toHaveBeenCalledWith('org-1', 'reviewer', expect.anything());
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'Manager on leave' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change reviewer' }));
    await waitFor(() =>
      expect(api.reassign).toHaveBeenCalledWith('rev-1', 'emp-7', 'Manager on leave'),
    );

    fireEvent.click(within(actions).getByRole('button', { name: 'Remove reviewer' }));
    const remove = await screen.findByRole('alertdialog', {
      name: 'Remove Grace Hopper as reviewer?',
    });
    fireEvent.change(within(remove).getByLabelText(/Why is the reviewer removed/), {
      target: { value: 'Conflict of interest' },
    });
    fireEvent.click(within(remove).getByRole('button', { name: 'Remove reviewer' }));
    await waitFor(() =>
      expect(api.reassign).toHaveBeenCalledWith('rev-1', null, 'Conflict of interest'),
    );
  });

  it('corrects a reviewer answer and the overall rating after confirmation', async () => {
    const finalized = review({
      viewer: 'HR',
      status: 'FINALIZED',
      selfStatus: 'SUBMITTED',
      reviewerStatus: 'SUBMITTED',
      overallRating: { value: 3, label: 'Meets Expectations' },
      responses: {
        'item-comm': { reviewer: { ratingValue: 3 } },
        'item-rel': { reviewer: { ratingValue: 3 } },
      } as unknown as ReviewDetail['responses'],
      actions: allowed({ canCorrect: true }),
    });
    api.review.mockResolvedValue(finalized);
    api.correct.mockResolvedValue(finalized);
    render(<ReviewPage reviewId="rev-1" />);
    const actions = await screen.findByRole('region', { name: 'HR actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Correct review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Correct review' });
    const submit = within(dialog).getByRole('button', { name: 'Correct review' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/Correct “Classroom management”/));
    fireEvent.change(within(dialog).getByLabelText('Classroom management rating'), {
      target: { value: '5' },
    });
    fireEvent.change(within(dialog).getByLabelText('Corrected overall rating'), {
      target: { value: '5' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason for the correction'), {
      target: { value: 'Calibration' },
    });
    fireEvent.click(submit);
    const confirm = await screen.findByRole('alertdialog', { name: 'Save this correction?' });
    expect(api.correct).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(api.correct).toHaveBeenCalledWith('rev-1', {
        answers: [expect.objectContaining({ itemId: 'item-rel', ratingValue: 5 })],
        overallRatingValue: 5,
        reason: 'Calibration',
      }),
    );
  });

  it('names the people in the history', async () => {
    api.review.mockResolvedValue(
      review({
        events: [
          {
            id: 'e1',
            type: 'REVIEWER_CHANGED',
            createdAt: '2026-11-02T10:00:00.000Z',
            actorName: 'Hana HR',
            fromEmployeeName: 'Grace Hopper',
            toEmployeeName: 'Katherine Johnson',
            reason: 'Manager on leave',
          },
        ] as unknown as ReviewDetail['events'],
      }),
    );
    render(<ReviewPage reviewId="rev-1" />);
    expect(await screen.findByText(/by Hana HR/)).toHaveTextContent(
      /Grace Hopper → Katherine Johnson.*Manager on leave/,
    );
  });

  it('shows a forbidden page without access', async () => {
    api.review.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<ReviewPage reviewId="rev-1" />);
    expect(await screen.findByText('You do not have access to this review.')).toBeInTheDocument();
  });
});

describe('PerformanceAdminPage', () => {
  const organization = (overrides = {}) => ({
    id: 'org-1',
    name: 'Harbourline',
    code: 'HBL',
    timezone: 'America/Toronto',
    actions: {
      canManageTemplates: false,
      canManageCycles: false,
      canManageEvidence: false,
      ...overrides,
    },
  });

  it('is forbidden without a performance permission, even for HR, payroll and benefits roles', () => {
    auth(['employee.manage', 'payroll.manage', 'benefit.manage']);
    render(<PerformanceAdminPage />);
    expect(
      screen.getByText('You do not have permission to view performance management.'),
    ).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('hides evidence management from readers and lists attention items', async () => {
    auth(['performance.read']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.templates.mockResolvedValue({ items: [] });
    api.cycles.mockResolvedValue({ items: [] });
    api.attention.mockResolvedValue({
      items: [
        {
          reviewId: 'rev-1',
          cycle: { id: 'c', name: 'Annual review 2026', status: 'OPEN' },
          employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
          positionName: 'Grade 3 Teacher',
          reviewer: null,
          status: 'NOT_STARTED',
          flags: ['NO_REVIEWER', 'OVERDUE_SELF'],
        },
      ],
    });
    render(<PerformanceAdminPage />);
    expect(await screen.findByText('No review cycles yet.')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Evidence sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create review cycle' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Needs attention' }));
    // Batch 10E-2: read the flags from the table; the same words are the reason filter's options.
    const attention = await screen.findByRole('region', { name: 'Reviews needing attention' });
    expect(within(attention).getByText(/No reviewer assigned/)).toBeInTheDocument();
    expect(within(attention).getByText(/Self review overdue/)).toBeInTheDocument();
  });

  it('closes a cycle only after confirmation, with an editable reason', async () => {
    auth(['performance.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageCycles: true })] });
    api.templates.mockResolvedValue({ items: [] });
    api.attention.mockResolvedValue({ items: [] });
    api.cycles.mockResolvedValue({
      items: [
        {
          id: 'cyc-1',
          code: 'ANNUAL-2026',
          name: 'Annual review 2026',
          description: null,
          status: 'OPEN',
          templateId: 'tpl-1',
          reviewerModel: 'DIRECT_MANAGER',
          selfReviewEnabled: true,
          acknowledgementEnabled: true,
          periodStart: '2026-01-01',
          periodEnd: '2026-12-31',
          windowStart: '2026-11-01',
          windowEnd: '2026-12-15',
          selfReviewDueDate: null,
          reviewerDueDate: null,
          scoringMode: null,
          overallRatingEnabled: null,
          reviewCounts: { IN_PROGRESS: 2 },
          actions: {
            canEdit: false,
            canAddReviews: false,
            canOpen: false,
            canClose: true,
            canArchive: false,
            canDiscard: false,
          },
        },
      ],
    });
    api.closeCycle.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Close Annual review 2026?' });
    expect(within(dialog).getByLabelText('Reason (optional)')).toHaveValue('Review window ended');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.closeCycle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Calibration complete' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close cycle' }));
    await waitFor(() =>
      expect(api.closeCycle).toHaveBeenCalledWith('cyc-1', {
        closeIncomplete: true,
        reason: 'Calibration complete',
      }),
    );
  });

  it('configures a Google Forms source and imports its results', async () => {
    auth(['performance.evidence.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageEvidence: true })] });
    api.templates.mockResolvedValue({ items: [] });
    api.cycles.mockResolvedValue({ items: [] });
    api.evidenceSources.mockResolvedValue({
      items: [
        {
          id: 'src-1',
          code: 'COC',
          name: 'Code of Conduct quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: 'form-1',
          resourceTitle: 'Staff Code of Conduct Quiz 2026',
          resourceUrl: null,
          passThresholdPercent: '80.00',
          lastSyncedAt: null,
          lastSyncStatus: null,
          lastSyncMessage: null,
          archived: false,
          evidenceCount: 0,
          pendingMatches: 0,
        },
      ],
    });
    api.importResults.mockResolvedValue({
      received: 2,
      counts: { CREATED: 1, PENDING_MATCH: 1, UNCHANGED: 0 },
      outcomes: [],
    });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Evidence sources' }));
    expect(await screen.findByText('80.00%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import results' }));
    const form = screen.getByRole('form', { name: 'Import results' });
    // Invalid JSON is refused on the field and never sent as an empty import.
    const payload = within(form).getByLabelText(/Results/);
    fireEvent.change(payload, { target: { value: '[{"externalResultId": "r1",' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Import' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('not valid JSON');
    expect(payload).toHaveAttribute('aria-invalid', 'true');
    expect(api.importResults).not.toHaveBeenCalled();
    expect(screen.queryByText('Results imported.')).not.toBeInTheDocument();
    fireEvent.change(payload, {
      target: {
        value: JSON.stringify([
          {
            externalResultId: 'r1',
            respondentEmail: 'ada@example.org',
            completedAt: '2026-09-01T14:30:00Z',
            score: '17',
            maxScore: '20',
          },
        ]),
      },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importResults).toHaveBeenCalledWith('src-1', [
        expect.objectContaining({ externalResultId: 'r1', respondentEmail: 'ada@example.org' }),
      ]),
    );
  });
});

describe('EmployeePerformanceSection', () => {
  beforeEach(() => {
    api.organizations.mockResolvedValue({ items: [{ id: 'org-1', name: 'Harbourline' }] });
  });

  it('explains a refused section without hiding the others', async () => {
    api.employeeReviews.mockRejectedValue(new AuthApiError('forbidden', 403));
    api.employeeGoals.mockResolvedValue({ items: [] });
    api.employeeEvidence.mockResolvedValue({ items: [] });
    render(<EmployeePerformanceSection employeeId="emp-1" />);
    expect(await screen.findByText('You do not have access to reviews.')).toBeInTheDocument();
    expect(await screen.findByText('No goals.')).toBeInTheDocument();
    expect(screen.queryByText('No reviews.')).not.toBeInTheDocument();
  });

  it('lists reviews with the historical reviewer and evidence results', async () => {
    api.employeeReviews.mockResolvedValue({
      items: [
        {
          id: 'rev-1',
          cycle: {
            id: 'c',
            code: 'A',
            name: 'Annual review 2025',
            status: 'CLOSED',
            periodStart: '2025-01-01',
            periodEnd: '2025-12-31',
          },
          positionName: 'Grade 3 Teacher',
          reviewer: { id: 'emp-9', displayName: 'Current Manager' },
          submittedBy: { id: 'emp-2', displayName: 'Former Manager' },
          status: 'CLOSED',
          selfStatus: 'SUBMITTED',
          reviewerStatus: 'SUBMITTED',
          overallRating: { value: 5, label: 'Exceptional' },
          calculatedScore: '4.80',
          finalizedAt: '2025-12-10T00:00:00.000Z',
          acknowledgedAt: '2025-12-11T00:00:00.000Z',
          closeReason: 'COMPLETED',
          awaitingAcknowledgement: false,
        },
      ],
    });
    api.employeeGoals.mockResolvedValue({ items: [goal()] });
    api.employeeEvidence.mockResolvedValue({ items: [quiz({ revision: 2 })] });
    render(<EmployeePerformanceSection employeeId="emp-1" />);
    expect(await screen.findByText('Former Manager')).toBeInTheDocument();
    expect(await screen.findByText('Revision 2')).toBeInTheDocument();
    expect(screen.getByText('17.00 / 20.00 (85.00%) · Passed')).toBeInTheDocument();
    expect(screen.getByText('Set by Grace Hopper')).toBeInTheDocument();
  });

  it('lets HR or the manager set a goal on a picked position, and retries a failed list', async () => {
    api.employeeReviews.mockResolvedValue({ items: [] });
    api.employeeGoals.mockResolvedValue({ items: [] });
    api.employeeEvidence.mockRejectedValueOnce(new AuthApiError('unexpected', 500));
    api.employeeEvidence.mockResolvedValue({ items: [] });
    api.options.mockResolvedValue({
      items: [{ id: 'asg-1', label: 'Ada Lovelace — Grade 3 Teacher', employeeId: 'emp-1' }],
      nextAfterId: null,
    });
    api.createGoal.mockResolvedValue(goal());
    render(<EmployeePerformanceSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry evidence' }));
    expect(await screen.findByText('No evidence.')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Set a goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set a goal for the employee' });
    fireEvent.focus(within(dialog).getByRole('combobox', { name: /Position/ }));
    fireEvent.click(await within(dialog).findByRole('option', { name: /Grade 3 Teacher/ }));
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'assignment',
      expect.objectContaining({ employeeId: 'emp-1' }),
    );
    fireEvent.change(within(dialog).getByLabelText('Goal'), {
      target: { value: 'Mentor a new teacher' },
    });
    fireEvent.change(within(dialog).getByLabelText('Start date'), {
      target: { value: '2026-01-15' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set goal' }));
    await waitFor(() =>
      expect(api.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          employmentAssignmentId: 'asg-1',
          title: 'Mentor a new teacher',
        }),
      ),
    );
  });

  it('cancels a goal only with a reason', async () => {
    api.employeeReviews.mockResolvedValue({ items: [] });
    api.employeeGoals.mockResolvedValue({ items: [goal()] });
    api.employeeEvidence.mockResolvedValue({ items: [] });
    api.updateGoal.mockResolvedValue(goal({ status: 'CANCELLED' }));
    render(<EmployeePerformanceSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Mentor a new teacher' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Cancel “Mentor a new teacher”?',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Cancel goal' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Why is the goal cancelled/), {
      target: { value: 'Moved to another school' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.updateGoal).toHaveBeenCalledWith('goal-1', {
        status: 'CANCELLED',
        cancellationReason: 'Moved to another school',
      }),
    );
  });
});
