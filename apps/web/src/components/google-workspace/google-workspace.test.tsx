import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { browserNavigation } from '../../lib/google-workspace/navigation';
import type {
  GoogleConnectionSummary,
  GoogleFormBinding,
  GoogleOrganization,
  GoogleSyncRun,
  GoogleWorkspaceStatus,
} from '../../lib/google-workspace/types';
import { GoogleWorkspacePage } from './google-workspace-page';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    status: vi.fn(),
    startOAuth: vi.fn(),
    connectServiceAccount: vi.fn(),
    disconnect: vi.fn(),
    healthCheck: vi.fn(),
    sources: vi.fn(),
    bindings: vi.fn(),
    createBinding: vi.fn(),
    updateBinding: vi.fn(),
    archiveBinding: vi.fn(),
    syncBinding: vi.fn(),
    syncRuns: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/google-workspace/api', () => ({ googleWorkspaceApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s';

const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    },
  });

const organization = (
  canManage = true,
  overrides: Partial<GoogleOrganization> = {},
): GoogleOrganization => ({
  id: ORG,
  name: 'Camp',
  code: 'CAMP',
  actions: { canRead: true, canManage },
  ...overrides,
});

const SCOPE = (name: string) => `https://www.googleapis.com/auth/${name}`;

const connection = (overrides: Partial<GoogleConnectionSummary> = {}): GoogleConnectionSummary => ({
  id: 'conn-1',
  mode: 'OAUTH',
  status: 'ACTIVE',
  workspaceDomain: 'camp.example.com',
  accountEmail: 'admin@camp.example.com',
  serviceAccountEmail: null,
  grantedScopes: [SCOPE('forms.body.readonly'), SCOPE('forms.responses.readonly')],
  capabilities: ['FORMS'],
  credentialsAvailable: true,
  connectedAt: '2026-10-01T12:00:00.000Z',
  connectedByUserId: 'user-1',
  lastHealthCheckAt: '2026-10-05T12:00:00.000Z',
  lastHealthOk: true,
  lastErrorCode: null,
  ...overrides,
});

const status = (overrides: Partial<GoogleWorkspaceStatus> = {}): GoogleWorkspaceStatus => {
  const oauthConfigured = overrides.oauthConfigured ?? true;
  const encryptionConfigured = overrides.encryptionConfigured ?? true;
  return {
    organizationId: ORG,
    canManage: true,
    oauthConfigured,
    encryptionConfigured,
    strategies: {
      OAUTH: {
        default: true,
        available: oauthConfigured && encryptionConfigured,
        requiresDomainWideDelegation: false,
      },
      SERVICE_ACCOUNT: {
        default: false,
        optional: true,
        available: encryptionConfigured,
        requiresDomainWideDelegation: true,
      },
    },
    capabilities: [
      {
        capability: 'FORMS',
        scopes: [SCOPE('forms.body.readonly'), SCOPE('forms.responses.readonly')],
        requiresDomainWideDelegation: false,
      },
      {
        capability: 'DRIVE_METADATA',
        scopes: [SCOPE('drive.metadata.readonly')],
        requiresDomainWideDelegation: false,
      },
      {
        capability: 'GMAIL_SEND',
        scopes: [SCOPE('gmail.send')],
        requiresDomainWideDelegation: false,
      },
      {
        capability: 'SHEETS_EXPORT',
        scopes: [SCOPE('drive.file')],
        requiresDomainWideDelegation: false,
      },
    ],
    connection: null,
    previousConnections: [],
    ...overrides,
  };
};

const binding = (overrides: Partial<GoogleFormBinding> = {}): GoogleFormBinding => ({
  id: 'b-1',
  organizationId: ORG,
  formId: 'form-abcdefghij',
  formTitle: 'Safety quiz',
  target: 'PERFORMANCE_EVIDENCE',
  performanceSourceId: 'ps-1',
  recruitmentSourceId: null,
  mapping: {
    schemaVersion: 1,
    fields: [{ questionId: 'q1', field: 'respondentEmail' }],
    scoreSource: 'QUIZ_TOTAL',
  },
  mappingSchemaVersion: 1,
  enabled: true,
  cursorSubmittedAt: null,
  lastSyncAt: '2026-10-05T10:00:00.000Z',
  lastSuccessAt: '2026-10-05T10:00:00.000Z',
  lastFailureAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
  nextSyncAfter: null,
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const run = (id: string, overrides: Partial<GoogleSyncRun> = {}): GoogleSyncRun => ({
  id,
  bindingId: 'b-1',
  target: 'PERFORMANCE_EVIDENCE',
  trigger: 'MANUAL',
  triggeredByUserId: 'user-1',
  status: 'SUCCEEDED',
  startedAt: '2026-10-05T10:00:00.000Z',
  finishedAt: '2026-10-05T10:00:05.000Z',
  fetched: 3,
  accepted: 2,
  duplicates: 1,
  rejected: 0,
  errorCode: null,
  ...overrides,
});

const sources = {
  performanceSources: [
    { id: 'ps-1', code: 'SAFETY', name: 'Safety quiz', formId: 'form-abcdefghij' },
    { id: 'ps-2', code: 'FIRSTAID', name: 'First aid', formId: 'form-firstaid01' },
  ],
  recruitmentSources: [
    { id: 'rs-1', code: 'CAREERS', name: 'Careers form', formId: 'form-careers001' },
  ],
};

function setup({
  org = organization(),
  state = status(),
  bindings = [] as GoogleFormBinding[],
  runs = [] as GoogleSyncRun[],
  total,
}: {
  org?: GoogleOrganization;
  state?: GoogleWorkspaceStatus;
  bindings?: GoogleFormBinding[];
  runs?: GoogleSyncRun[];
  total?: number;
} = {}) {
  api.organizations.mockResolvedValue({ items: [org] });
  api.status.mockResolvedValue(state);
  api.bindings.mockResolvedValue({ items: bindings });
  api.sources.mockResolvedValue(sources);
  api.syncRuns.mockResolvedValue({
    total: total ?? runs.length,
    limit: 10,
    offset: 0,
    items: runs,
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReset();
  auth(['integration.google.manage']);
  window.history.replaceState(null, '', '/settings/integrations/google');
});

afterEach(() => cleanup());

describe('GoogleWorkspacePage', () => {
  it('is forbidden without an integration permission', () => {
    auth(['notification.settings.manage']);
    render(<GoogleWorkspacePage />);
    expect(
      screen.getByText('You do not have permission to view the Google Workspace integration.'),
    ).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('explains a deployment without OAuth or encryption and disables connecting', async () => {
    setup({ state: status({ oauthConfigured: false, encryptionConfigured: false }) });
    render(<GoogleWorkspacePage />);
    const notice = await screen.findByRole('note', { name: 'Configuration missing' });
    expect(notice).toHaveTextContent('Google sign-in (the OAuth client) is not configured');
    expect(notice).toHaveTextContent('Credential encryption is not configured');
    expect(notice).toHaveTextContent('No secrets are shown here.');
    expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeDisabled();
    expect(
      screen.getByText(
        'Unavailable: Google sign-in (OAuth) is not configured for this deployment.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect service account' })).toBeDisabled();
  });

  it('starts OAuth with the selected capabilities and navigates only to Google', async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    setup();
    api.startOAuth.mockResolvedValue({
      authorizationUrl: GOOGLE_URL,
      expiresAt: '2026-10-06T10:10:00Z',
    });
    render(<GoogleWorkspacePage />);
    const form = await screen.findByRole('form', { name: 'Connect with Google' });
    expect(within(form).getByLabelText('Google Forms (read forms and responses)')).toBeChecked();
    expect(within(form).getByRole('list', { name: 'Scopes for Gmail send' })).toHaveTextContent(
      SCOPE('gmail.send'),
    );
    fireEvent.click(within(form).getByLabelText('Google Drive file details (metadata only)'));
    fireEvent.click(within(form).getByRole('button', { name: 'Connect with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    expect(api.startOAuth).toHaveBeenCalledWith(ORG, ['FORMS', 'DRIVE_METADATA']);

    // The page stays busy while the browser leaves for Google.
    expect(within(form).getByRole('button', { name: 'Connect with Google' })).toBeDisabled();
  });

  it("never opens an authorization URL that is not Google's", async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    setup();
    api.startOAuth.mockResolvedValue({
      authorizationUrl: 'https://evil.example/auth',
      expiresAt: '',
    });
    render(<GoogleWorkspacePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Google' }));
    expect(
      await screen.findByText(
        'The authorization link did not point to Google. Nothing was opened.',
      ),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('explains a refused OAuth start', async () => {
    setup();
    api.startOAuth.mockRejectedValue(new AuthApiError('service-unavailable', 503));
    render(<GoogleWorkspacePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'not configured for this deployment',
    );
  });

  it('shows the callback error banner from the query string and cleans the URL', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/integrations/google?result=error&code=GOOGLE_WORKSPACE_ACCOUNT_REQUIRED',
    );
    setup();
    render(<GoogleWorkspacePage />);
    const banner = await screen.findByRole('alert', { name: 'Google connection result' });
    expect(banner).toHaveTextContent('Google Workspace was not connected.');
    expect(banner).toHaveTextContent('personal Gmail account cannot be connected');
    expect(window.location.search).toBe('');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByRole('alert', { name: 'Google connection result' }),
    ).not.toBeInTheDocument();
  });

  it('never renders an unknown callback code', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/integrations/google?result=error&code=%3Cb%3Ehi%3C%2Fb%3E',
    );
    setup();
    render(<GoogleWorkspacePage />);
    const banner = await screen.findByRole('alert', { name: 'Google connection result' });
    expect(banner).toHaveTextContent('could not be completed');
    expect(banner.innerHTML).not.toContain('<b>');
    expect(banner).not.toHaveTextContent('hi');
  });

  it('shows the success banner and selects the connected organization', async () => {
    window.history.replaceState(
      null,
      '',
      `/settings/integrations/google?result=connected&organizationId=${ORG2}`,
    );
    setup();
    api.organizations.mockResolvedValue({
      items: [organization(), organization(true, { id: ORG2, name: 'Lake', code: 'LAKE' })],
    });
    api.status.mockImplementation((id: string) =>
      Promise.resolve(status({ organizationId: id, connection: connection() })),
    );
    render(<GoogleWorkspacePage />);
    expect(
      await screen.findByRole('status', { name: 'Google connection result' }),
    ).toHaveTextContent('Google Workspace connected.');
    expect(screen.getByLabelText('Organization')).toHaveValue(ORG2);
    await waitFor(() => expect(api.status).toHaveBeenCalledWith(ORG2));
  });

  it('shows the connected card and runs health checks and disconnects', async () => {
    setup({
      state: status({
        connection: connection({
          capabilities: ['FORMS', 'GMAIL_SEND'],
          lastErrorCode: 'GOOGLE_RATE_LIMITED',
        }),
        previousConnections: [
          {
            id: 'old-1',
            mode: 'SERVICE_ACCOUNT',
            workspaceDomain: 'old.example.com',
            connectedAt: '2026-01-01T00:00:00.000Z',
            disconnectedAt: '2026-02-01T00:00:00.000Z',
            disconnectedByUserId: 'user-1',
          },
        ],
      }),
    });
    api.healthCheck.mockResolvedValue({
      organizationId: ORG,
      result: 'ACTIVE',
      connection: connection(),
    });
    api.disconnect.mockResolvedValue({ organizationId: ORG, revoked: true, connection: null });
    render(<GoogleWorkspacePage />);
    const card = await screen.findByRole('region', { name: 'Connection' });
    expect(within(card).getByText('Connected')).toBeInTheDocument();
    expect(within(card).getByText('Connected with Google (OAuth)')).toBeInTheDocument();
    expect(within(card).getByText('camp.example.com')).toBeInTheDocument();
    expect(within(card).getByText('admin@camp.example.com')).toBeInTheDocument();
    const granted = within(card).getByRole('list', { name: 'Granted capabilities' });
    expect(granted).toHaveTextContent('Forms');
    expect(granted).toHaveTextContent('Gmail send');
    expect(within(card).getByText(/· OK$/)).toBeInTheDocument();
    expect(within(card).getByText('GOOGLE_RATE_LIMITED')).toBeInTheDocument();
    expect(within(card).getByText(/old\.example\.com/)).toBeInTheDocument();
    // Connected: no first-time connect section, but a reconnect option.
    expect(screen.queryByRole('region', { name: 'Connect with Google' })).not.toBeInTheDocument();
    expect(screen.getByText('Reconnect with Google or change capabilities')).toBeInTheDocument();
    expect(screen.queryByText(/Advanced: service account/)).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Check health' }));
    expect(
      await screen.findByText('Health check passed: Google accepted the connection.'),
    ).toBeInTheDocument();
    expect(api.healthCheck).toHaveBeenCalledWith(ORG);

    // The shared ConfirmDialog: cancelling changes nothing.
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Disconnect Google Workspace?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }),
    );
    expect(await screen.findByText('Google Workspace disconnected.')).toBeInTheDocument();
    expect(api.disconnect).toHaveBeenCalledWith(ORG);
  });

  it('connects a service account and never keeps the key', async () => {
    setup();
    api.connectServiceAccount.mockRejectedValue(
      new AuthApiError('validation', 400, 'bad', { code: 'GOOGLE_SERVICE_ACCOUNT_REJECTED' }),
    );
    render(<GoogleWorkspacePage />);
    const form = await screen.findByRole('form', { name: 'Connect a service account' });
    expect(form).toHaveTextContent('domain-wide delegation');
    const key = within(form).getByLabelText('Service-account key (JSON)');
    fireEvent.change(key, { target: { value: '{"type":"service_account","private_key":"k"}' } });
    fireEvent.change(within(form).getByLabelText('Workspace user to act as'), {
      target: { value: 'admin@camp.example.com' },
    });
    fireEvent.click(within(form).getByLabelText('Gmail (send notification email)'));
    fireEvent.click(within(form).getByRole('button', { name: 'Connect service account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a Workspace super-admin configured domain-wide delegation',
    );
    expect(api.connectServiceAccount).toHaveBeenCalledWith({
      organizationId: ORG,
      keyJson: '{"type":"service_account","private_key":"k"}',
      impersonatedUser: 'admin@camp.example.com',
      capabilities: ['FORMS', 'GMAIL_SEND'],
    });
    expect(key).toHaveValue('');
  });

  it('creates, edits, toggles and archives form bindings', async () => {
    setup({ state: status({ connection: connection() }), bindings: [binding()] });
    api.createBinding.mockResolvedValue(binding({ id: 'b-2', formTitle: 'First aid quiz' }));
    api.updateBinding.mockResolvedValue(binding());
    api.archiveBinding.mockResolvedValue(binding({ archivedAt: '2026-10-06T00:00:00Z' }));
    render(<GoogleWorkspacePage />);

    const item = await screen.findByRole('listitem', { name: 'Binding Safety quiz' });
    expect(item).toHaveTextContent('Performance evidence');
    expect(item).toHaveTextContent('Safety quiz (SAFETY)');
    expect(within(item).getByRole('list', { name: 'Mapping of Safety quiz' })).toHaveTextContent(
      'q1 → Respondent email',
    );
    expect(item).toHaveTextContent('Score: Quiz total score');

    // Create
    fireEvent.click(screen.getByRole('button', { name: 'New form binding' }));
    const create = screen.getByRole('form', { name: 'New form binding' });
    fireEvent.click(within(create).getByRole('button', { name: 'Create binding' }));
    expect(within(create).getByRole('alert')).toHaveTextContent('Choose the source');
    expect(api.createBinding).not.toHaveBeenCalled();
    fireEvent.change(within(create).getByLabelText('Target'), {
      target: { value: 'RECRUITMENT_INTAKE' },
    });
    const sourceSelect = within(create).getByLabelText('Source');
    expect(
      within(sourceSelect)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a source', 'Careers form (CAREERS)']);
    fireEvent.change(within(create).getByLabelText('Target'), {
      target: { value: 'PERFORMANCE_EVIDENCE' },
    });
    fireEvent.change(within(create).getByLabelText('Source'), { target: { value: 'ps-2' } });
    expect(within(create).getByLabelText('Google Form id')).toHaveValue('form-firstaid01');
    fireEvent.click(within(create).getByRole('button', { name: 'Add question' }));
    fireEvent.change(within(create).getByLabelText('Question id 1'), { target: { value: 'q9' } });
    const field = within(create).getByLabelText('Field 1');
    expect(
      within(field)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a field', 'Respondent email', 'Respondent reference']);
    fireEvent.change(field, { target: { value: 'respondentReference' } });
    fireEvent.change(within(create).getByLabelText('Score'), { target: { value: 'NONE' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create binding' }));
    expect(await screen.findByText('Form First aid quiz bound.')).toBeInTheDocument();
    expect(api.createBinding).toHaveBeenCalledWith({
      organizationId: ORG,
      formId: 'form-firstaid01',
      target: 'PERFORMANCE_EVIDENCE',
      performanceSourceId: 'ps-2',
      mapping: {
        schemaVersion: 1,
        fields: [{ questionId: 'q9', field: 'respondentReference' }],
        scoreSource: 'NONE',
      },
      enabled: true,
    });
    expect(screen.queryByRole('form', { name: 'New form binding' })).not.toBeInTheDocument();

    // Edit mapping
    fireEvent.click(within(item).getByRole('button', { name: 'Edit mapping Safety quiz' }));
    const edit = within(item).getByRole('form', { name: 'Edit mapping Safety quiz' });
    expect(within(edit).getByLabelText('Question id 1')).toHaveValue('q1');
    fireEvent.change(within(edit).getByLabelText('Question id 1'), { target: { value: 'q2' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('Mapping of Safety quiz saved.')).toBeInTheDocument();
    expect(api.updateBinding).toHaveBeenCalledWith('b-1', {
      mapping: {
        schemaVersion: 1,
        fields: [{ questionId: 'q2', field: 'respondentEmail' }],
        scoreSource: 'QUIZ_TOTAL',
      },
    });

    // Disable
    fireEvent.click(within(item).getByRole('button', { name: 'Disable Safety quiz' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Disable binding',
      }),
    );
    expect(await screen.findByText('Binding Safety quiz disabled.')).toBeInTheDocument();
    expect(api.updateBinding).toHaveBeenLastCalledWith('b-1', { enabled: false });

    // Archive (confirmed)
    fireEvent.click(within(item).getByRole('button', { name: 'Archive Safety quiz' }));
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Archive the binding of Safety quiz?' }),
      ).getByRole('button', { name: 'Archive binding' }),
    );
    expect(await screen.findByText('Binding Safety quiz archived.')).toBeInTheDocument();
    expect(api.archiveBinding).toHaveBeenCalledWith('b-1');
  });

  it('explains a refused binding with the domain code', async () => {
    setup({ state: status({ connection: connection() }) });
    api.createBinding.mockRejectedValue(
      new AuthApiError('conflict', 409, 'x', { code: 'GOOGLE_FORM_ALREADY_BOUND' }),
    );
    render(<GoogleWorkspacePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New form binding' }));
    const create = screen.getByRole('form', { name: 'New form binding' });
    fireEvent.change(within(create).getByLabelText('Target'), {
      target: { value: 'ONBOARDING_TASKS' },
    });
    expect(within(create).queryByLabelText('Source')).not.toBeInTheDocument();
    fireEvent.change(within(create).getByLabelText('Google Form id'), {
      target: { value: 'form-onboard001' },
    });
    fireEvent.click(within(create).getByRole('button', { name: 'Create binding' }));
    expect(await screen.findByText(/already has a live binding/)).toBeInTheDocument();
    expect(api.createBinding).toHaveBeenCalledWith({
      organizationId: ORG,
      formId: 'form-onboard001',
      target: 'ONBOARDING_TASKS',
      mapping: { schemaVersion: 1, fields: [] },
      enabled: true,
    });
  });

  it('syncs now and explains throttling and running syncs', async () => {
    setup({ state: status({ connection: connection() }), bindings: [binding()] });
    api.syncBinding
      .mockResolvedValueOnce({
        status: 'SUCCEEDED',
        bindingId: 'b-1',
        runId: 'r-1',
        fetched: 3,
        accepted: 2,
        duplicates: 1,
        rejected: 0,
        errorCode: null,
      })
      .mockRejectedValueOnce(new AuthApiError('rate-limited', 429))
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'x', { code: 'GOOGLE_SYNC_IN_PROGRESS' }),
      );
    render(<GoogleWorkspacePage />);
    const sync = await screen.findByRole('button', { name: 'Sync now Safety quiz' });
    fireEvent.click(sync);
    expect(
      await screen.findByText(
        'Synchronization finished: 3 fetched, 2 accepted, 1 duplicates, 0 rejected.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'synchronized less than a minute ago',
    );
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already running'));
    expect(api.syncBinding).toHaveBeenCalledTimes(3);
  });

  it('pages and filters the synchronization history', async () => {
    setup({
      state: status({ connection: connection() }),
      bindings: [binding()],
      runs: [
        run('r-1', { status: 'FAILED', errorCode: 'GOOGLE_AUTH_REVOKED', trigger: 'SCHEDULED' }),
      ],
      total: 25,
    });
    render(<GoogleWorkspacePage />);
    const history = await screen.findByRole('region', { name: 'Synchronization history' });
    expect(await within(history).findByText('Showing 1–1 of 25')).toBeInTheDocument();
    expect(within(history).getByText('Failed')).toBeInTheDocument();
    expect(within(history).getByText('Scheduled')).toBeInTheDocument();
    expect(within(history).getByText(/Access was revoked in Google/)).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.syncRuns).toHaveBeenLastCalledWith({
        organizationId: ORG,
        bindingId: null,
        limit: 10,
        offset: 10,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show runs Safety quiz' }));
    await waitFor(() =>
      expect(api.syncRuns).toHaveBeenLastCalledWith({
        organizationId: ORG,
        bindingId: 'b-1',
        limit: 10,
        offset: 0,
      }),
    );
    expect(within(history).getByLabelText('Form')).toHaveValue('b-1');
  });

  it('is read-only for readers', async () => {
    auth(['integration.google.read']);
    setup({
      org: organization(false),
      state: status({ canManage: false, connection: connection() }),
      bindings: [binding()],
      runs: [run('r-1')],
    });
    render(<GoogleWorkspacePage />);
    expect(
      await screen.findByText(
        'You have read-only access to this organization’s Google Workspace integration.',
      ),
    ).toBeInTheDocument();
    const item = await screen.findByRole('listitem', { name: 'Binding Safety quiz' });
    expect(item).toHaveTextContent('Configured source');
    for (const name of ['Check health', 'Disconnect', 'New form binding', 'Connect with Google']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(item).queryByRole('button', { name: /Sync now/ })).not.toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Show runs Safety quiz' })).toBeInTheDocument();
    expect(screen.queryByText(/Advanced: service account/)).not.toBeInTheDocument();
    expect(api.sources).not.toHaveBeenCalled();
  });

  it('shows an empty state without organizations', async () => {
    api.organizations.mockResolvedValue({ items: [] });
    render(<GoogleWorkspacePage />);
    expect(
      await screen.findByText(
        'No organizations are within your Google Workspace integration access.',
      ),
    ).toBeInTheDocument();
  });
});
