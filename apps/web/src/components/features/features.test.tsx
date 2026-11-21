import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { expectNoAxeViolations } from '../../test/axe';
import type {
  FeatureChange,
  FeaturesOverview,
  ModuleState,
  SettingState,
} from '../../lib/features/types';
import { FeatureDisabledNotice } from './feature-disabled-notice';
import { DISABLE_CONSEQUENCES, FeaturesAdminPage, moduleLockReason } from './features-admin-page';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    overview: vi.fn(),
    history: vi.fn(),
    setModule: vi.fn(),
    setSetting: vi.fn(),
    resetSetting: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/features/api', () => ({ featuresApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    identity: { id: 'user-1' },
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const moduleState = (overrides: Partial<ModuleState> & Pick<ModuleState, 'module' | 'name'>) =>
  ({
    description: `${overrides.name} description.`,
    enabled: true,
    isDefault: true,
    requires: [],
    dependents: [],
    blockedBy: [],
    version: 0,
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  }) as ModuleState;

const setting = (overrides: Partial<SettingState> & Pick<SettingState, 'key' | 'name'>) =>
  ({
    section: 'DOCUMENTS',
    description: `${overrides.name} description.`,
    type: { kind: 'boolean' },
    value: true,
    default: true,
    isDefault: true,
    schemaVersion: 1,
    version: 0,
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  }) as SettingState;

function overview(overrides: Partial<FeaturesOverview> = {}): FeaturesOverview {
  return {
    organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
    canManage: true,
    core: ['Organization structure', 'Employees', 'Audit'],
    modules: [
      moduleState({ module: 'ATTENDANCE', name: 'Time & attendance', dependents: ['PAYROLL'] }),
      moduleState({ module: 'COMPENSATION', name: 'Compensation', dependents: ['PAYROLL'] }),
      moduleState({
        module: 'PAYROLL',
        name: 'Payroll',
        requires: ['COMPENSATION', 'ATTENDANCE'],
      }),
      moduleState({ module: 'DOCUMENTS', name: 'Documents', version: 2, isDefault: false }),
    ],
    settings: [
      setting({ key: 'documents.selfServiceProvide', name: 'Employees provide documents' }),
      setting({
        key: 'performance.reminderDays',
        name: 'Reminder days',
        section: 'PERFORMANCE',
        type: { kind: 'integer', min: 1, max: 30 },
        value: 7,
        default: 7,
      }),
      setting({
        key: 'performance.ratingScale',
        name: 'Rating scale',
        section: 'PERFORMANCE',
        type: { kind: 'enum', values: ['FIVE_POINT', 'THREE_POINT'] },
        value: 'THREE_POINT',
        default: 'FIVE_POINT',
        isDefault: false,
        version: 4,
      }),
    ],
    linked: {
      timeAttendance: {
        available: true,
        endpoint: '/time/policies?organizationId=org-1',
        activeLayers: 3,
        currentLayers: 2,
        organizationLayer: {
          id: 'p-1',
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          inheritanceMode: 'MERGE',
          attendance: {},
          clockMode: 'SELF_SERVICE',
          breaksMode: null,
          missedPunchEnabled: true,
        },
      },
      notifications: {
        available: true,
        endpoint: '/notifications/settings?organizationId=org-1',
        emailEnabled: false,
        suppressMandatoryEmail: false,
        categoriesEmailDisabled: ['LEAVE'],
        updatedAt: null,
      },
      googleWorkspace: { available: false, reason: 'FORBIDDEN' },
    },
    ...overrides,
  };
}

const change = (id: string, overrides: Partial<FeatureChange> = {}): FeatureChange => ({
  id,
  kind: 'MODULE',
  subject: 'DOCUMENTS',
  oldValue: true,
  newValue: false,
  version: 1,
  actorUserId: 'user-1',
  changedAt: '2026-10-05T12:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth(['feature.manage']);
  api.organizations.mockResolvedValue({
    items: [
      {
        id: 'org-1',
        name: 'Camp',
        code: 'CAMP',
        actions: { canRead: true, canManage: true },
      },
    ],
  });
  api.overview.mockResolvedValue(overview());
  api.history.mockResolvedValue({ items: [], nextBefore: null });
  api.setModule.mockResolvedValue({});
  api.setSetting.mockResolvedValue({});
  api.resetSetting.mockResolvedValue({});
});

afterEach(() => cleanup());

const moduleItem = (name: string) => screen.getByRole('listitem', { name: `Module ${name}` });
const settingItem = (name: string) => screen.getByRole('listitem', { name: `Setting ${name}` });

async function renderPage() {
  render(<FeaturesAdminPage />);
  await screen.findByRole('switch', { name: 'Payroll enabled' });
}

describe('FeaturesAdminPage', () => {
  it('requires feature.read or feature.manage', () => {
    auth(['notification.settings.manage']);
    render(<FeaturesAdminPage />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('shows core HR, modules with their dependencies and the linked sections', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Settings & features' })).toBeInTheDocument();
    const core = screen.getByRole('list', { name: 'Core HR areas' });
    expect(within(core).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(moduleItem('Payroll')).getByText('Requires: Compensation, Time & attendance'),
    ).toBeInTheDocument();
    expect(
      within(moduleItem('Compensation')).getByText('Required by: Payroll'),
    ).toBeInTheDocument();

    const time = screen.getByRole('article', { name: 'Time & attendance policy' });
    expect(within(time).getByText('2 of 3 active')).toBeInTheDocument();
    expect(within(time).getByText('Self Service')).toBeInTheDocument();
    expect(within(time).getByRole('link', { name: 'Manage attendance policies' })).toHaveAttribute(
      'href',
      '/admin/time',
    );
    const notifications = screen.getByRole('article', { name: 'Notifications' });
    expect(within(notifications).getByText('Leave')).toBeInTheDocument();
    expect(within(notifications).getByRole('link')).toHaveAttribute('href', '/admin/notifications');
    const google = screen.getByRole('article', { name: 'Google Workspace' });
    expect(
      within(google).getByText('You do not have permission to view this section.'),
    ).toBeInTheDocument();
    expect(within(google).queryByRole('link')).not.toBeInTheDocument();
  });

  it('links Google Workspace when available and explains a disabled linked module', async () => {
    api.overview.mockResolvedValue(
      overview({
        linked: {
          ...overview().linked,
          notifications: { available: false, reason: 'FEATURE_DISABLED' },
          googleWorkspace: {
            available: true,
            endpoint: '/integrations/google/status?organizationId=org-1',
            status: 'ACTIVE',
            mode: 'OAUTH',
            capabilities: ['FORMS'],
            lastHealthOk: true,
            lastHealthCheckAt: '2026-10-05T12:00:00.000Z',
          },
        },
      }),
    );
    await renderPage();
    const google = screen.getByRole('article', { name: 'Google Workspace' });
    expect(within(google).getByRole('link')).toHaveAttribute(
      'href',
      '/settings/integrations/google',
    );
    expect(within(google).getByText('Active')).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Notifications' })).getByText(
        'This module is turned off for the organization.',
      ),
    ).toBeInTheDocument();
  });

  it('confirms before disabling a module and sends the expected version', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Documents enabled' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Turn off Documents?' });
    expect(within(dialog).getByText(DISABLE_CONSEQUENCES)).toBeInTheDocument();
    expect(api.setModule).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.setModule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('switch', { name: 'Documents enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Documents' }));
    await screen.findByText('Documents turned off.');
    expect(api.setModule).toHaveBeenCalledWith('DOCUMENTS', {
      organizationId: 'org-1',
      enabled: false,
      expectedVersion: 2,
    });
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));
    expect(api.history).toHaveBeenCalledTimes(2);
  });

  it('enables a module without confirmation', async () => {
    api.overview.mockResolvedValue(
      overview({
        modules: [
          moduleState({ module: 'DOCUMENTS', name: 'Documents', enabled: false, version: 1 }),
        ],
      }),
    );
    render(<FeaturesAdminPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Documents enabled' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await screen.findByText('Documents turned on.');
    expect(api.setModule).toHaveBeenCalledWith('DOCUMENTS', {
      organizationId: 'org-1',
      enabled: true,
      expectedVersion: 1,
    });
  });

  it('locks switches blocked by dependencies and explains why', async () => {
    api.overview.mockResolvedValue(
      overview({
        modules: [
          moduleState({ module: 'ATTENDANCE', name: 'Time & attendance', dependents: ['PAYROLL'] }),
          moduleState({
            module: 'COMPENSATION',
            name: 'Compensation',
            dependents: ['PAYROLL'],
            enabled: false,
          }),
          moduleState({
            module: 'PAYROLL',
            name: 'Payroll',
            enabled: false,
            requires: ['COMPENSATION', 'ATTENDANCE'],
            blockedBy: ['COMPENSATION'],
          }),
        ],
      }),
    );
    await renderPage();
    const payroll = screen.getByRole('switch', { name: 'Payroll enabled' });
    expect(payroll).toBeDisabled();
    expect(payroll).toHaveAccessibleDescription('Turn on Compensation first: Payroll requires it.');
    // Payroll is off, so Time & attendance can be turned off; Compensation can be turned on.
    expect(screen.getByRole('switch', { name: 'Time & attendance enabled' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Compensation enabled' })).toBeEnabled();
  });

  it('locks a module while an enabled dependent requires it', async () => {
    await renderPage();
    const compensation = screen.getByRole('switch', { name: 'Compensation enabled' });
    expect(compensation).toBeDisabled();
    expect(compensation).toHaveAccessibleDescription(
      'Turn off Payroll first: it depends on Compensation.',
    );
    expect(
      moduleLockReason(
        moduleState({
          module: 'PAYROLL',
          name: 'Payroll',
          enabled: false,
          blockedBy: ['A', 'B'] as never,
        }),
        [],
      ),
    ).toBe('Turn on A, B first: Payroll requires them.');
  });

  it('shows the dependency refusal of the API and reloads', async () => {
    api.setModule.mockRejectedValue(
      new AuthApiError('conflict', 409, 'Payroll depends on Documents.', {
        code: 'FEATURE_DEPENDENTS_ENABLED',
        dependents: ['PAYROLL'],
      }),
    );
    await renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Documents enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Documents' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This module cannot be turned off while Payroll depends on it. Turn it off first.',
    );
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));
  });

  it('reloads with a message after an optimistic-concurrency conflict', async () => {
    api.setSetting.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The configuration changed.', {
        code: 'FEATURE_VERSION_CONFLICT',
        key: 'documents.selfServiceProvide',
        currentVersion: 1,
      }),
    );
    await renderPage();
    api.overview.mockResolvedValue(
      overview({
        settings: [
          setting({
            key: 'documents.selfServiceProvide',
            name: 'Employees provide documents',
            value: false,
            isDefault: false,
            version: 1,
          }),
        ],
      }),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Employees provide documents' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /changed this configuration since it was loaded/,
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Employees provide documents' })).not.toBeChecked(),
    );
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(
      within(settingItem('Employees provide documents')).getByText('Customized'),
    ).toBeInTheDocument();
  });

  it('edits typed settings and resets them to the default', async () => {
    await renderPage();
    // Boolean: saved immediately.
    fireEvent.click(screen.getByRole('switch', { name: 'Employees provide documents' }));
    await screen.findByText('Employees provide documents saved.');
    expect(api.setSetting).toHaveBeenLastCalledWith('documents.selfServiceProvide', {
      organizationId: 'org-1',
      value: false,
      expectedVersion: 0,
    });
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));

    // Integer: bounded, saved as a number.
    const days = await screen.findByRole('spinbutton', { name: 'Reminder days' });
    expect(days).toHaveAttribute('min', '1');
    expect(days).toHaveAttribute('max', '30');
    const saveDays = screen.getByRole('button', { name: 'Save Reminder days' });
    expect(saveDays).toBeDisabled();
    fireEvent.change(days, { target: { value: '45' } });
    expect(screen.getByText('Enter a number from 1 to 30.')).toBeInTheDocument();
    expect(saveDays).toBeDisabled();
    fireEvent.change(days, { target: { value: '14' } });
    fireEvent.click(saveDays);
    await screen.findByText('Reminder days saved.');
    expect(api.setSetting).toHaveBeenLastCalledWith('performance.reminderDays', {
      organizationId: 'org-1',
      value: 14,
      expectedVersion: 0,
    });

    // Enum: a select of the allowed values.
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(3));
    const scale = screen.getByRole('combobox', { name: 'Rating scale' });
    expect(
      within(scale)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Five Point', 'Three Point']);
    fireEvent.change(scale, { target: { value: 'FIVE_POINT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Rating scale' }));
    await screen.findByText('Rating scale saved.');
    expect(api.setSetting).toHaveBeenLastCalledWith('performance.ratingScale', {
      organizationId: 'org-1',
      value: 'FIVE_POINT',
      expectedVersion: 4,
    });

    // Default indicator and reset.
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(4));
    expect(within(settingItem('Reminder days')).getByText('Default')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Reminder days to default' })).toBeDisabled();
    const scaleItem = settingItem('Rating scale');
    expect(within(scaleItem).getByText('Customized')).toBeInTheDocument();
    expect(within(scaleItem).getByText('Default: Five Point')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Rating scale to default' }));
    await screen.findByText('Rating scale reset to its default.');
    expect(api.resetSetting).toHaveBeenCalledWith('performance.ratingScale', {
      organizationId: 'org-1',
      expectedVersion: 4,
    });
    expect(screen.getByRole('group', { name: 'Performance settings' })).toBeInTheDocument();
  });

  it('groups CORE settings and validates retention periods (0 or at least the minimum)', async () => {
    api.overview.mockResolvedValue(
      overview({
        settings: [
          setting({
            key: 'retention.auditLogMonths',
            name: 'Delete audit log entries after (months)',
            section: 'CORE',
            type: { kind: 'integer', min: 0, max: 240, minWhenEnabled: 24 },
            value: 0,
            default: 0,
          }),
        ],
      }),
    );
    await renderPage();
    const group = screen.getByRole('group', { name: 'Core HR & audit settings' });
    expect(within(group).getByRole('heading', { name: 'Core HR & audit' })).toBeInTheDocument();
    expect(within(group).getByText('0 = keep forever (retention off)')).toBeInTheDocument();
    expect(within(group).getByText('0 (off) or 24–240')).toBeInTheDocument();

    const months = within(group).getByRole('spinbutton', {
      name: 'Delete audit log entries after (months)',
    });
    const save = within(group).getByRole('button', {
      name: 'Save Delete audit log entries after (months)',
    });
    fireEvent.change(months, { target: { value: '12' } });
    expect(
      within(group).getByText('Enter 0 to turn this off, or a number from 24 to 240.'),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(months, { target: { value: '300' } });
    expect(save).toBeDisabled();
    fireEvent.change(months, { target: { value: '36' } });
    expect(within(group).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(save);
    await screen.findByText('Delete audit log entries after (months) saved.');
    expect(api.setSetting).toHaveBeenLastCalledWith('retention.auditLogMonths', {
      organizationId: 'org-1',
      value: 36,
      expectedVersion: 0,
    });
  });

  it('pages the change history', async () => {
    api.history
      .mockResolvedValueOnce({
        items: [
          change('c-1'),
          change('c-2', {
            kind: 'SETTING',
            subject: 'performance.ratingScale',
            oldValue: null,
            newValue: 'THREE_POINT',
            actorUserId: 'abcdef12-3456',
          }),
        ],
        nextBefore: '2026-10-05T11:00:00.000Z',
      })
      .mockResolvedValueOnce({
        items: [change('c-3', { subject: 'PAYROLL', oldValue: false, newValue: true })],
        nextBefore: null,
      });
    await renderPage();
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('Documents')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('You')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Rating scale')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Default')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('User abcdef12')).toBeInTheDocument();
    expect(api.history).toHaveBeenLastCalledWith('org-1', { limit: 20, before: null });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
    expect(api.history).toHaveBeenLastCalledWith('org-1', {
      limit: 20,
      before: '2026-10-05T11:00:00.000Z',
    });
    expect(screen.getByText('Payroll', { selector: 'td' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('is read-only without manage access', async () => {
    auth(['feature.read']);
    api.overview.mockResolvedValue(overview({ canManage: false }));
    await renderPage();
    expect(screen.getByRole('note')).toHaveTextContent(
      'You can view the settings of Camp but not change them.',
    );
    for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Reminder days' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Rating scale' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Reset/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
    // No lock explanations when nothing can be changed anyway.
    expect(screen.queryByText(/first:/)).not.toBeInTheDocument();
  });

  it('switches organizations and reports load failures', async () => {
    api.organizations.mockResolvedValue({
      items: [
        { id: 'org-1', name: 'Camp', code: 'CAMP', actions: { canRead: true, canManage: true } },
        { id: 'org-2', name: 'Lake', code: 'LAKE', actions: { canRead: true, canManage: false } },
      ],
    });
    await renderPage();
    api.overview.mockRejectedValue(new AuthApiError('forbidden', 403));
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-2' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to manage features.',
    );
    expect(api.overview).toHaveBeenLastCalledWith('org-2');
  });
});

describe('Security remediation M2: payroll dual control setting', () => {
  const dual = (overrides: Partial<SettingState> = {}) =>
    setting({
      key: 'payroll.dualControl',
      name: 'Payroll dual control',
      section: 'PAYROLL',
      value: true,
      default: true,
      guarded: true,
      ...overrides,
    });

  it('only a System administrator can turn it off; others see why', async () => {
    api.overview.mockResolvedValue(
      overview({ settings: [dual()], canRelaxGuardedSettings: false }),
    );
    await renderPage();
    const toggle = screen.getByRole('switch', { name: 'Payroll dual control' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(
      within(settingItem('Payroll dual control')).getByText(
        'Only a System administrator can turn this off.',
      ),
    ).toBeInTheDocument();
  });

  it('a System administrator turns it off with a reason and an explicit confirmation', async () => {
    api.overview.mockResolvedValue(overview({ settings: [dual()], canRelaxGuardedSettings: true }));
    await renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Payroll dual control' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off payroll dual control?' });
    expect(dialog).toHaveTextContent(/one person will be able to prepare and approve payroll/i);
    const submit = within(dialog).getByRole('button', { name: 'Turn off dual control' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Single-person payroll office this month' },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'I understand one person will be able to prepare and approve payroll.',
      }),
    );
    expect(submit).toBeEnabled();
    await expectNoAxeViolations(dialog);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenLastCalledWith('payroll.dualControl', {
        organizationId: 'org-1',
        value: false,
        expectedVersion: 0,
        reason: 'Single-person payroll office this month',
        confirm: true,
      }),
    );
  });

  it('turning it back on needs no reason or dialog', async () => {
    api.overview.mockResolvedValue(
      overview({
        settings: [dual({ value: false, isDefault: false, version: 1 })],
        canRelaxGuardedSettings: false,
      }),
    );
    await renderPage();
    const toggle = screen.getByRole('switch', { name: 'Payroll dual control' });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenLastCalledWith('payroll.dualControl', {
        organizationId: 'org-1',
        value: true,
        expectedVersion: 1,
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('FeatureDisabledNotice', () => {
  it('explains a disabled feature and ignores other errors', () => {
    const { rerender } = render(
      <FeatureDisabledNotice
        error={
          new AuthApiError('forbidden', 403, undefined, {
            code: 'FEATURE_DISABLED',
            module: 'RECRUITMENT',
          })
        }
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recruitment is turned off for your organization.',
    );
    rerender(<FeatureDisabledNotice error={new AuthApiError('forbidden', 403)} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
