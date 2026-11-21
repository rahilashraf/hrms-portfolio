import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { Cycle, Evidence, IntakeItem } from '../../lib/performance/types';
import { adminErrorMessage, CODE_PATTERN } from './admin/shared';
import { parseLevels } from './admin/config';
import { PerformanceAdminPage } from './performance-admin-page';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    options: vi.fn(),
    competencies: vi.fn(),
    createCompetency: vi.fn(),
    updateCompetency: vi.fn(),
    archiveCompetency: vi.fn(),
    scales: vi.fn(),
    createScale: vi.fn(),
    updateScale: vi.fn(),
    transitionScale: vi.fn(),
    templates: vi.fn(),
    template: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    transitionTemplate: vi.fn(),
    copyTemplate: vi.fn(),
    cycles: vi.fn(),
    cycle: vi.fn(),
    createCycle: vi.fn(),
    updateCycle: vi.fn(),
    discardCycle: vi.fn(),
    cycleReviews: vi.fn(),
    addReviews: vi.fn(),
    removeReview: vi.fn(),
    transitionCycle: vi.fn(),
    closeCycle: vi.fn(),
    attention: vi.fn(),
    evidenceSources: vi.fn(),
    createEvidenceSource: vi.fn(),
    updateEvidenceSource: vi.fn(),
    archiveEvidenceSource: vi.fn(),
    importResults: vi.fn(),
    intake: vi.fn(),
    resolveIntake: vi.fn(),
    recordEvidence: vi.fn(),
    correctEvidence: vi.fn(),
    remapEvidence: vi.fn(),
    withdrawEvidence: vi.fn(),
    evidenceHistory: vi.fn(),
    employeeEvidence: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/performance/api', () => ({ performanceApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;

const organization = (actions = {}) => ({
  id: 'org-1',
  name: 'Harbourline',
  code: 'HBL',
  timezone: 'America/Toronto',
  actions: {
    canManageTemplates: true,
    canManageCycles: true,
    canManageEvidence: true,
    ...actions,
  },
});

const cycle = (overrides: Partial<Cycle> = {}): Cycle => ({
  id: 'cyc-1',
  code: 'ANNUAL-2026',
  name: 'Annual review 2026',
  description: null,
  status: 'DRAFT',
  templateId: 'tpl-1',
  template: { id: 'tpl-1', code: 'ANNUAL', name: 'Annual' },
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
  reviewCounts: {},
  actions: {
    canEdit: true,
    canAddReviews: true,
    canOpen: true,
    canClose: false,
    canArchive: false,
    canDiscard: true,
  },
  ...overrides,
});

const manual = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: 'ev-1',
  organizationId: 'org-1',
  employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
  employmentAssignment: null,
  provider: 'CERTIFICATION',
  kind: 'CERTIFICATION',
  channel: 'MANUAL',
  title: 'First Aid',
  sourceName: null,
  completedAt: '2026-05-20T12:00:00.000Z',
  score: null,
  maxScore: null,
  percentage: null,
  passed: true,
  passThresholdPercent: null,
  status: 'ACTIVE',
  withdrawalReason: null,
  revision: 1,
  importedAt: '2026-05-20T12:00:00.000Z',
  sync: null,
  notes: 'Confidential HR note',
  actions: { canManage: true },
  ...overrides,
});

const intakeItem = (overrides: Partial<IntakeItem> = {}): IntakeItem => ({
  id: 'in-1',
  source: { id: 'src-1', code: 'COC', name: 'Code of Conduct quiz', provider: 'GOOGLE_FORMS' },
  externalResultId: 'resp-1',
  respondentEmail: null,
  respondentReference: 'Unverified email: ada@example.org',
  result: { title: 'Code of Conduct quiz', score: '17', maxScore: '20' },
  status: 'PENDING_MATCH',
  reason: 'EMAIL_UNVERIFIED',
  receivedAt: '2026-09-01T15:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: ['performance.manage', 'performance.evidence.manage'].map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
      })),
    },
  });
  api.organizations.mockResolvedValue({ items: [organization()] });
  api.templates.mockResolvedValue({ items: [] });
  api.cycles.mockResolvedValue({ items: [] });
  api.scales.mockResolvedValue({ items: [] });
  api.competencies.mockResolvedValue({ items: [] });
  api.evidenceSources.mockResolvedValue({ items: [] });
  api.attention.mockResolvedValue({ items: [], nextAfterId: null });
  api.intake.mockResolvedValue({ items: [], nextAfterId: null });
  api.cycleReviews.mockResolvedValue({ items: [], nextAfterId: null, total: 0 });
  api.options.mockResolvedValue({ items: [], nextAfterId: null });
});
// Batch 10E-2: tab clicks now write the section into the URL (#hash); every test starts from a
// clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

/** Opens a combobox and picks the option named `name`. */
async function pick(scope: HTMLElement, label: string, name: RegExp) {
  const input = within(scope).getByRole('combobox', { name: label });
  fireEvent.focus(input);
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('admin helpers', () => {
  it('names the active templates of a 409 PERFORMANCE_CONFIG_IN_USE', () => {
    const conflict = new AuthApiError('conflict', 409, undefined, {
      code: 'PERFORMANCE_CONFIG_IN_USE',
      templates: [{ id: 't', code: 'ANNUAL', name: 'Annual review' }],
    });
    expect(adminErrorMessage(conflict)).toBe(
      'In use by active templates: Annual review (ANNUAL). Archive or replace those templates first.',
    );
  });

  it('validates codes and scale levels like the API', () => {
    expect(CODE_PATTERN.test('ANNUAL-2027')).toBe(true);
    expect(CODE_PATTERN.test('A')).toBe(false);
    expect(CODE_PATTERN.test('Annual 2027')).toBe(false);
    expect(parseLevels('1 Low\n5 High')).toEqual([
      { value: 1, label: 'Low', description: null },
      { value: 5, label: 'High', description: null },
    ]);
    expect(parseLevels('1 Low')).toBeNull();
    expect(parseLevels('one Low\n2 High')).toBeNull();
  });
});

describe('PerformanceAdminPage — cycles (Batch 7B)', () => {
  it('shows a cycle in detail with its filtered reviews and loads more', async () => {
    api.cycles.mockResolvedValue({ items: [cycle({ reviewCounts: { NOT_STARTED: 3 } })] });
    api.cycleReviews
      .mockResolvedValueOnce({
        items: [
          {
            id: 'rev-1',
            employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
            employmentAssignment: { id: 'a1', positionName: 'Teacher' },
            reviewer: null,
            status: 'NOT_STARTED',
            selfStatus: 'NOT_STARTED',
            reviewerStatus: 'NOT_STARTED',
            overdue: [],
          },
        ],
        nextAfterId: 'rev-1',
        total: 2,
      })
      .mockResolvedValue({
        items: [
          {
            id: 'rev-2',
            employee: { id: 'emp-2', employeeNumber: 'E-2', displayName: 'Grace Hopper' },
            employmentAssignment: { id: 'a2', positionName: 'Principal' },
            reviewer: { id: 'emp-9', displayName: 'Alan Turing' },
            status: 'NOT_STARTED',
            selfStatus: 'NOT_STARTED',
            reviewerStatus: 'NOT_STARTED',
            overdue: [],
          },
        ],
        nextAfterId: null,
        total: 2,
      });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show Annual review 2026' }));
    const detail = await screen.findByRole('region', { name: 'Details of Annual review 2026' });
    expect(await within(detail).findByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(detail).getByText('Showing 1 of 2')).toBeInTheDocument();
    expect(api.cycleReviews).toHaveBeenCalledWith('cyc-1', { limit: 50 });
    fireEvent.click(within(detail).getByRole('button', { name: 'Load more reviews' }));
    expect(await within(detail).findByText('Grace Hopper')).toBeInTheDocument();
    expect(api.cycleReviews).toHaveBeenLastCalledWith('cyc-1', { limit: 50, afterId: 'rev-1' });

    fireEvent.change(within(detail).getByLabelText('Status'), { target: { value: 'SUBMITTED' } });
    fireEvent.click(within(detail).getByLabelText('Without a reviewer'));
    fireEvent.click(within(detail).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(api.cycleReviews).toHaveBeenLastCalledWith('cyc-1', {
        status: 'SUBMITTED',
        withoutReviewer: true,
        limit: 50,
      }),
    );
  });

  it('adds chosen assignments from the performance picker and reports what happened', async () => {
    api.cycles.mockResolvedValue({ items: [cycle()] });
    api.options.mockResolvedValue({
      items: [
        { id: 'asg-1', label: 'Ada Lovelace', description: 'E-1 · Teacher', employeeId: 'e1' },
      ],
      nextAfterId: null,
    });
    api.addReviews.mockResolvedValue({ added: 1, skipped: 0, withoutReviewer: 0, excludedOwn: 1 });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add reviews' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add reviews to Annual review 2026' });
    await pick(dialog, 'Employee assignment', /Ada Lovelace/);
    expect(api.options).toHaveBeenCalledWith('org-1', 'assignment', { limit: 20 });
    expect(within(dialog).getByRole('list', { name: 'Chosen employees' })).toHaveTextContent(
      'Ada Lovelace — E-1 · Teacher',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add chosen reviews' }));
    await waitFor(() =>
      expect(api.addReviews).toHaveBeenCalledWith('cyc-1', { assignmentIds: ['asg-1'] }),
    );
    expect(
      await within(dialog).findByText(
        '1 added, 0 already in the cycle, 0 without a reviewer, 1 of your own left out.',
      ),
    ).toBeInTheDocument();
    // No raw ID entry anywhere.
    expect(within(dialog).queryByLabelText(/ID/)).not.toBeInTheDocument();
  });

  it('confirms adding everyone of a team before sending it', async () => {
    api.cycles.mockResolvedValue({ items: [cycle()] });
    api.options.mockResolvedValue({
      items: [{ id: 'team-1', label: 'Grade 3', description: 'G3' }],
      nextAfterId: null,
    });
    api.addReviews.mockResolvedValue({ added: 4, skipped: 1, withoutReviewer: 2 });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add reviews' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/Everyone of the organization/));
    fireEvent.change(within(dialog).getByLabelText('Narrow to'), { target: { value: 'teamId' } });
    await pick(dialog, 'Team', /Grade 3/);
    expect(api.options).toHaveBeenCalledWith('org-1', 'team', { limit: 20 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add everyone' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('the chosen team');
    expect(api.addReviews).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, add everyone' }));
    await waitFor(() =>
      expect(api.addReviews).toHaveBeenCalledWith('cyc-1', {
        allInOrganization: true,
        teamId: 'team-1',
      }),
    );
  });

  it('edits an open cycle within what its status allows', async () => {
    api.cycles.mockResolvedValue({
      items: [
        cycle({
          status: 'OPEN',
          actions: {
            canEdit: true,
            canAddReviews: true,
            canOpen: false,
            canClose: true,
            canArchive: false,
            canDiscard: false,
          },
        }),
      ],
    });
    api.updateCycle.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show Annual review 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit cycle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Annual review 2026' });
    expect(within(dialog).queryByLabelText('Review period start')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Window opens')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Window closes'), {
      target: { value: '2026-12-20' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save cycle' }));
    await waitFor(() =>
      expect(api.updateCycle).toHaveBeenCalledWith('cyc-1', {
        name: 'Annual review 2026',
        description: null,
        windowEnd: '2026-12-20',
        selfReviewDueDate: null,
        reviewerDueDate: null,
      }),
    );
  });

  it('opens and discards a draft only after confirmation', async () => {
    api.cycles.mockResolvedValue({ items: [cycle()] });
    api.transitionCycle.mockResolvedValue({});
    api.discardCycle.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Open Annual review 2026?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open cycle' }));
    await waitFor(() => expect(api.transitionCycle).toHaveBeenCalledWith('cyc-1', 'open'));

    fireEvent.click(await screen.findByRole('button', { name: 'Show Annual review 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Discard Annual review 2026?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard cycle' }));
    await waitFor(() => expect(api.discardCycle).toHaveBeenCalledWith('cyc-1'));
  });

  it('keeps the page usable when a section fails to load, with a retry', async () => {
    api.cycles.mockRejectedValueOnce(new AuthApiError('unexpected', 500));
    render(<PerformanceAdminPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to load review cycles');
    expect(screen.queryByText('No review cycles yet.')).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No review cycles yet.')).toBeInTheDocument();
  });
});

describe('PerformanceAdminPage — configuration (Batch 7B)', () => {
  it('shows which active templates block archiving a scale', async () => {
    api.scales.mockResolvedValue({
      items: [
        {
          id: 'sc-1',
          code: 'FIVE',
          name: 'Five point',
          description: null,
          status: 'ACTIVE',
          levels: [
            { value: 1, label: 'Low', description: null },
            { value: 5, label: 'High', description: null },
          ],
        },
      ],
    });
    api.transitionScale.mockRejectedValue(
      new AuthApiError('conflict', 409, undefined, {
        code: 'PERFORMANCE_CONFIG_IN_USE',
        templates: [{ id: 't1', code: 'ANNUAL', name: 'Annual review' }],
      }),
    );
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Rating scales' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Five point' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive scale' }));
    expect(
      await screen.findByText(
        'In use by active templates: Annual review (ANNUAL). Archive or replace those templates first.',
      ),
    ).toBeInTheDocument();
    // Levels of an active scale are not editable.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Five point' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit Five point' });
    expect(within(edit).queryByLabelText(/Levels/)).not.toBeInTheDocument();
  });

  it('edits a competency', async () => {
    api.competencies.mockResolvedValue({
      items: [
        {
          id: 'k1',
          code: 'COMM',
          name: 'Communication',
          description: null,
          category: null,
          archived: false,
        },
      ],
    });
    api.updateCompetency.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Competencies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Communication' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Category'), { target: { value: 'Core' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save competency' }));
    await waitFor(() =>
      expect(api.updateCompetency).toHaveBeenCalledWith('k1', {
        name: 'Communication',
        category: 'Core',
        description: null,
      }),
    );
  });

  it('copies a template into a new version with an explicit, validated code', async () => {
    api.templates.mockResolvedValue({
      items: [
        {
          id: 'tpl-1',
          code: 'ANNUAL',
          name: 'Annual',
          description: null,
          status: 'ACTIVE',
          scoringMode: 'NONE',
          overallRatingEnabled: true,
          ratingScale: null,
          sectionCount: 1,
          itemCount: 2,
          cycleCount: 1,
        },
      ],
    });
    api.copyTemplate.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Templates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New version of Annual' }));
    const dialog = await screen.findByRole('dialog', { name: 'New version of Annual' });
    const code = within(dialog).getByLabelText(/^New code/);
    const submit = within(dialog).getByRole('button', { name: 'Create draft version' });
    fireEvent.change(code, { target: { value: 'annual 2027' } });
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(submit).toBeDisabled();
    fireEvent.change(code, { target: { value: 'annual' } });
    expect(within(dialog).getByText('The new version needs its own code.')).toBeInTheDocument();
    fireEvent.change(code, { target: { value: 'annual-2027' } });
    fireEvent.change(within(dialog).getByLabelText('New name'), {
      target: { value: 'Annual 2027' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.copyTemplate).toHaveBeenCalledWith('tpl-1', 'ANNUAL-2027', 'Annual 2027'),
    );
  });

  it('edits a draft template: removes an item and saves the content whole', async () => {
    api.templates.mockResolvedValue({
      items: [
        {
          id: 'tpl-1',
          code: 'DRAFT-T',
          name: 'Draft template',
          description: null,
          status: 'DRAFT',
          scoringMode: 'NONE',
          overallRatingEnabled: true,
          ratingScale: { id: 'sc-1', code: 'FIVE', name: 'Five point' },
          sectionCount: 1,
          itemCount: 2,
          cycleCount: 0,
        },
      ],
    });
    api.scales.mockResolvedValue({
      items: [
        {
          id: 'sc-1',
          code: 'FIVE',
          name: 'Five point',
          description: null,
          status: 'DRAFT',
          levels: [],
        },
      ],
    });
    api.template.mockResolvedValue({
      id: 'tpl-1',
      code: 'DRAFT-T',
      name: 'Draft template',
      description: null,
      status: 'DRAFT',
      scoringMode: 'NONE',
      overallRatingEnabled: true,
      ratingScale: {
        id: 'sc-1',
        code: 'FIVE',
        name: 'Five point',
        description: null,
        status: 'DRAFT',
        levels: [],
      },
      sections: [
        {
          id: 's1',
          title: 'Core',
          description: null,
          items: [
            {
              id: 'i1',
              itemType: 'TEXT',
              prompt: 'Highlights',
              respondent: 'BOTH',
              required: true,
              competency: null,
              ratingScale: null,
            },
            {
              id: 'i2',
              itemType: 'YES_NO',
              prompt: 'Goals met?',
              respondent: 'REVIEWER',
              required: false,
              competency: null,
              ratingScale: null,
            },
          ],
        },
      ],
      actions: { canEdit: true, canActivate: true, canArchive: true, canCopy: true },
    });
    api.updateTemplate.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Templates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show Draft template' }));
    expect(
      await screen.findByText(
        'Its rating scale is a draft: activate the scale before the template.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Draft template' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove item 2 of section 1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(api.updateTemplate).toHaveBeenCalled());
    const [, input] = api.updateTemplate.mock.calls[0]!;
    expect(input).toMatchObject({ scoringMode: 'NONE', ratingScaleId: 'sc-1' });
    expect(input.sections).toHaveLength(1);
    expect(input.sections[0].items.map((i: { prompt: string }) => i.prompt)).toEqual([
      'Highlights',
    ]);
  });
});

describe('PerformanceAdminPage — evidence (Batch 7B)', () => {
  it('records evidence for an employee chosen from the performance picker', async () => {
    api.options.mockImplementation(async (_org: string, kind: string) =>
      kind === 'employee'
        ? { items: [{ id: 'emp-1', label: 'Ada Lovelace', description: 'E-1' }], nextAfterId: null }
        : { items: [], nextAfterId: null },
    );
    api.recordEvidence.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Evidence records' }));
    const form = await screen.findByRole('form', { name: 'Record evidence' });
    await pick(form, 'Employee', /Ada Lovelace/);
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'First Aid' } });
    fireEvent.change(within(form).getByLabelText('Completed on'), {
      target: { value: '2026-05-20' },
    });
    fireEvent.change(within(form).getByLabelText('Result'), { target: { value: 'yes' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record evidence' }));
    await waitFor(() =>
      expect(api.recordEvidence).toHaveBeenCalledWith({
        organizationId: 'org-1',
        employeeId: 'emp-1',
        employmentAssignmentId: null,
        provider: 'CERTIFICATION',
        kind: 'CERTIFICATION',
        title: 'First Aid',
        completedAt: '2026-05-20T12:00:00.000Z',
        score: null,
        maxScore: null,
        passed: true,
        resultUrl: null,
        notes: null,
      }),
    );
  });

  it('corrects manual evidence with a reason, withdraws with a reason, and shows the history', async () => {
    api.options.mockResolvedValue({
      items: [{ id: 'emp-1', label: 'Ada Lovelace', description: 'E-1' }],
      nextAfterId: null,
    });
    api.employeeEvidence.mockResolvedValue({
      items: [manual(), manual({ id: 'ev-2', title: 'Quiz', channel: 'SYNC', notes: undefined })],
    });
    api.correctEvidence.mockResolvedValue({});
    api.withdrawEvidence.mockResolvedValue({});
    api.evidenceHistory.mockResolvedValue({
      items: [
        {
          ...manual({ revision: 2, title: 'First Aid (CPR)' }),
          correctionReason: 'Course name',
          supersededAt: null,
          recordedBy: { userId: 'u1', displayName: 'Hana HR' },
        },
        {
          ...manual(),
          correctionReason: null,
          supersededAt: '2026-06-01T10:00:00.000Z',
          recordedBy: { userId: 'u1', displayName: 'Hana HR' },
        },
      ],
    });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Evidence records' }));
    const section = await screen.findByRole('region', { name: 'Employee evidence' });
    await pick(section, 'Employee', /Ada Lovelace/);
    await within(section).findByText('First Aid');
    expect(api.employeeEvidence).toHaveBeenCalledWith('emp-1', 'ACTIVE');
    expect(within(section).getByText('Notes: Confidential HR note')).toBeInTheDocument();
    // Only manual evidence is corrected here (imports are corrected at their source).
    expect(within(section).queryByRole('button', { name: 'Correct Quiz' })).not.toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Correct First Aid' }));
    const dialog = await screen.findByRole('dialog', { name: 'Correct First Aid' });
    const save = within(dialog).getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Title'), {
      target: { value: 'First Aid (CPR)' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason for the correction'), {
      target: { value: 'Course name' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.correctEvidence).toHaveBeenCalledWith(
        'ev-1',
        expect.objectContaining({
          title: 'First Aid (CPR)',
          completedAt: '2026-05-20T12:00:00.000Z',
          notes: 'Confidential HR note',
          reason: 'Course name',
        }),
      ),
    );

    fireEvent.click(await within(section).findByRole('button', { name: 'Withdraw First Aid' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Withdraw First Aid?' });
    fireEvent.change(within(confirm).getByLabelText(/Reason/), { target: { value: 'Duplicate' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Withdraw evidence' }));
    await waitFor(() => expect(api.withdrawEvidence).toHaveBeenCalledWith('ev-1', 'Duplicate'));

    fireEvent.click(await within(section).findByRole('button', { name: 'History of First Aid' }));
    const history = await screen.findByRole('dialog', { name: 'History of First Aid' });
    expect(await within(history).findByText('Reason: Course name')).toBeInTheDocument();
    expect(within(history).getAllByText(/Recorded by Hana HR/)).toHaveLength(2);
    expect(within(history).getByText(/superseded/)).toBeInTheDocument();
  });

  it('re-maps evidence to another employee with a required reason', async () => {
    api.options.mockImplementation(async () => ({
      items: [
        { id: 'emp-1', label: 'Ada Lovelace', description: 'E-1' },
        { id: 'emp-2', label: 'Grace Hopper', description: 'E-2' },
      ],
      nextAfterId: null,
    }));
    api.employeeEvidence.mockResolvedValue({ items: [manual()] });
    api.remapEvidence.mockResolvedValue({});
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Evidence records' }));
    const section = await screen.findByRole('region', { name: 'Employee evidence' });
    await pick(section, 'Employee', /Ada Lovelace/);
    fireEvent.click(
      await within(section).findByRole('button', { name: 'Move First Aid to another employee' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Re-map First Aid' });
    await pick(dialog, 'Move to employee', /Grace Hopper/);
    const submit = within(dialog).getByRole('button', { name: 'Re-map evidence' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Wrong person' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.remapEvidence).toHaveBeenCalledWith('ev-1', {
        employeeId: 'emp-2',
        employmentAssignmentId: null,
        reason: 'Wrong person',
      }),
    );
  });
});

describe('PerformanceAdminPage — intake and attention (Batch 7B)', () => {
  it('quarantines unverified emails and rejects a result with the user’s reason', async () => {
    api.intake.mockResolvedValue({ items: [intakeItem()], nextAfterId: 'in-1' });
    api.resolveIntake.mockResolvedValue({ status: 'REJECTED' });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Unmatched results' }));
    const table = await screen.findByRole('region', { name: 'Imported results' });
    expect(within(table).getByText('Unverified')).toBeInTheDocument();
    expect(within(table).getByText(/not verified by the form/)).toBeInTheDocument();
    expect(api.intake).toHaveBeenCalledWith('org-1', { status: 'PENDING_MATCH' });

    fireEvent.click(within(table).getByRole('button', { name: 'Reject resp-1' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reject resp-1?' });
    const confirm = within(dialog).getByRole('button', { name: 'Reject result' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'A visitor, not staff' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.resolveIntake).toHaveBeenCalledWith('in-1', {
        action: 'REJECT',
        note: 'A visitor, not staff',
      }),
    );

    api.intake.mockResolvedValue({
      items: [
        intakeItem({
          id: 'in-2',
          externalResultId: 'resp-2',
          status: 'REJECTED',
          resolutionNote: 'Not staff',
        }),
      ],
      nextAfterId: null,
    });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'REJECTED' } });
    expect(await screen.findByText('Not staff')).toBeInTheDocument();
    expect(api.intake).toHaveBeenLastCalledWith('org-1', { status: 'REJECTED' });
  });

  it('filters attention by cycle and flag and loads more', async () => {
    api.cycles.mockResolvedValue({ items: [cycle()] });
    const row = (id: string, name: string) => ({
      reviewId: id,
      cycle: { id: 'cyc-1', name: 'Annual review 2026', status: 'OPEN' },
      employee: { id: `e-${id}`, employeeNumber: id, displayName: name },
      positionName: 'Teacher',
      reviewer: null,
      status: 'NOT_STARTED',
      flags: ['NO_REVIEWER'],
    });
    api.attention
      .mockResolvedValueOnce({ items: [row('r1', 'Ada Lovelace')], nextAfterId: 'r1' })
      .mockResolvedValueOnce({ items: [row('r2', 'Grace Hopper')], nextAfterId: null })
      .mockResolvedValue({ items: [], nextAfterId: null });
    render(<PerformanceAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Needs attention' }));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more reviews' }));
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(api.attention).toHaveBeenLastCalledWith('org-1', { afterId: 'r1' });
    await screen.findByRole('option', { name: 'Annual review 2026' });
    fireEvent.change(screen.getByLabelText('Cycle'), { target: { value: 'cyc-1' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'NO_REVIEWER' } });
    await waitFor(() =>
      expect(api.attention).toHaveBeenLastCalledWith('org-1', {
        cycleId: 'cyc-1',
        flag: 'NO_REVIEWER',
      }),
    );
    expect(await screen.findByText('No reviews need attention.')).toBeInTheDocument();
  });
});
