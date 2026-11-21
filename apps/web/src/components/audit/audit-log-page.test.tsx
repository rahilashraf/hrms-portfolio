import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { AuditEntry } from '../../lib/audit/types';
import { TruncatedNotice, truncatedNoticeText } from '../organization/shared';
import { AuditLogPage } from './audit-log-page';
import { expectNoAxeViolations } from '../../test/axe';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  actors: vi.fn(),
  listOrganizations: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../../lib/audit/api', () => ({
  auditApi: { list: mocks.list, actors: mocks.actors },
}));
vi.mock('../../lib/organization/api', () => ({
  organizationApi: { listOrganizations: mocks.listOrganizations },
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const ACTOR = '7b0c2f1e-7a5f-4c55-8f0e-3d9f3c1b2a10';

const auth = (scopes: Array<{ type: string; id?: string }>, key = 'audit.read') =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: { userId: 'u', permissions: [{ key, scopes }] },
  });

const entry = (id: string, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  occurredAt: '2026-10-05T12:00:00.000Z',
  action: 'EMPLOYEE_CREATED',
  entityType: 'Employee',
  entityId: `emp-${id}`,
  actor: { userId: ACTOR, displayName: 'Ada Admin' },
  requestId: `req-${id}`,
  metadata: { organizationId: 'org-1' },
  ...overrides,
});

const page = (items: AuditEntry[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  range: { from: '2026-09-05T12:00:00.000Z', to: '2026-10-05T12:00:00.000Z' },
});

beforeEach(() => {
  vi.clearAllMocks();
  auth([{ type: 'ORGANIZATION', id: 'org-1' }]);
  mocks.listOrganizations.mockResolvedValue([
    { id: 'org-1', name: 'Camp' },
    { id: 'org-2', name: 'Other' },
  ]);
  mocks.list.mockResolvedValue(page([]));
  mocks.actors.mockResolvedValue({
    items: [{ userId: ACTOR, displayName: 'Ada Admin' }],
    nextAfterId: null,
  });
});

afterEach(() => cleanup());

describe('AuditLogPage', () => {
  it('requires audit.read', () => {
    auth([{ type: 'ORGANIZATION', id: 'org-1' }], 'feature.manage');
    render(<AuditLogPage />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists the readable organizations and renders entries as plain text', async () => {
    mocks.list.mockResolvedValue(
      page([
        entry('1', {
          metadata: {
            organizationId: 'org-1',
            changedFields: ['firstName', 'lastName'],
            status: '<img src=x onerror=alert(1)>',
            retroactive: false,
          },
        }),
        entry('2', { actor: { userId: ACTOR, displayName: null }, metadata: {} }),
        entry('3', { actor: null, requestId: null, entityType: null, entityId: null }),
      ]),
    );
    const { container } = render(<AuditLogPage />);
    const rows = await screen.findAllByRole('row', { name: /Audit entry/ });
    expect(rows).toHaveLength(3);
    // Only the organization of the grant is offered (with its name).
    const select = screen.getByRole('combobox', { name: 'Organization' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Camp']);
    expect(mocks.list).toHaveBeenCalledWith({ organizationId: 'org-1', limit: 50 });

    const first = rows[0]!;
    expect(within(first).getByText('Ada Admin')).toBeInTheDocument();
    expect(within(first).getByText('req-1')).toBeInTheDocument();
    expect(within(first).getByText('emp-1')).toBeInTheDocument();
    // The record type reads as words, with its code below.
    expect(within(first).getByText('Employee', { selector: 'span' })).toBeInTheDocument();
    expect(within(first).getByText('changedFields')).toBeInTheDocument();
    expect(within(first).getByText('firstName, lastName')).toBeInTheDocument();
    expect(within(first).getByText('false')).toBeInTheDocument();
    // Never HTML: the markup is shown as text and no element is created.
    expect(within(first).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(within(rows[1]!).getByText(ACTOR)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('System')).toBeInTheDocument();
  });

  it('names account security actions and offers the System view to System-scope readers (Batch 2)', async () => {
    auth([{ type: 'SYSTEM' }]);
    mocks.list.mockResolvedValue(
      page([
        entry('9', {
          action: 'AUTH_LOGIN_FAILED',
          entityType: 'User',
          actor: null,
          metadata: { organizationId: 'org-1', reasonCode: 'INVALID_PASSWORD' },
        }),
      ]),
    );
    render(<AuditLogPage />);
    const row = await screen.findByRole('row', { name: 'Audit entry AUTH_LOGIN_FAILED' });
    expect(within(row).getByText('Sign-in failed')).toBeInTheDocument();
    expect(within(row).getByText('INVALID_PASSWORD')).toBeInTheDocument();
    const select = screen.getByLabelText('Organization');
    expect(
      within(select).getByRole('option', { name: 'System (no organization)' }),
    ).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'system' } });
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'system' }),
      ),
    );
  });

  it('filters, validates and loads more with the cursor', async () => {
    mocks.list
      .mockResolvedValueOnce(page([entry('1')]))
      .mockResolvedValueOnce(page([entry('2')], 'cursor-1'))
      .mockResolvedValueOnce(page([entry('3', { action: 'EMPLOYEE_UPDATED' })]));
    render(<AuditLogPage />);
    await screen.findByText('req-1');

    // An id typed by hand (for someone not listed) is still validated.
    fireEvent.click(screen.getByRole('button', { name: 'Enter an ID instead' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'User id' }), {
      target: { value: 'not-a-uuid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The actor user id must be a UUID.');
    expect(mocks.list).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole('textbox', { name: 'User id' }), {
      target: { value: ACTOR },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), {
      target: { value: 'EMPLOYEE_CREATED' },
    });
    fireEvent.change(screen.getByLabelText('From (date)'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To (date, inclusive)'), {
      target: { value: '2026-09-30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('req-2');
    const filters = {
      organizationId: 'org-1',
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 9, 1).toISOString(),
      action: 'EMPLOYEE_CREATED',
      actorUserId: ACTOR,
    };
    expect(mocks.list).toHaveBeenLastCalledWith({ ...filters, limit: 50 });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('req-3');
    expect(mocks.list).toHaveBeenLastCalledWith({ ...filters, limit: 50, cursor: 'cursor-1' });
    expect(screen.getByText('req-2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('picks the actor by name and filters by record type, sending the ids (Batch R3.3)', async () => {
    render(<AuditLogPage />);
    await screen.findByText('No audit entries match these filters.');
    const actor = screen.getByRole('combobox', { name: /^Performed by/ });
    fireEvent.focus(actor);
    fireEvent.change(actor, { target: { value: 'Ada' } });
    fireEvent.click(await screen.findByRole('option', { name: /Ada Admin/ }, { timeout: 2000 }));
    await waitFor(() =>
      expect(mocks.actors).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-1', query: 'Ada' }),
      ),
    );
    // The record type shows a readable name and sends the code.
    const type = screen.getByRole('combobox', { name: 'Record type' });
    expect(within(type).getByRole('option', { name: 'Benefit coverage option' })).toHaveValue(
      'BenefitCoverageOption',
    );
    fireEvent.change(type, { target: { value: 'Employee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({
        organizationId: 'org-1',
        entityType: 'Employee',
        actorUserId: ACTOR,
        limit: 50,
      }),
    );
  });

  it('has no axe violations in the filters', async () => {
    render(<AuditLogPage />);
    await screen.findByText('No audit entries match these filters.');
    await expectNoAxeViolations(screen.getByRole('form', { name: 'Audit filters' }));
  });

  it('accepts a record type that is not listed ("Other")', async () => {
    render(<AuditLogPage />);
    await screen.findByText('No audit entries match these filters.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Record type' }), {
      target: { value: '__other__' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Record type code' }), {
      target: { value: 'NewModuleThing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({
        organizationId: 'org-1',
        entityType: 'NewModuleThing',
        limit: 50,
      }),
    );
  });

  it('clears the actor when another organization is chosen', async () => {
    auth([
      { type: 'ORGANIZATION', id: 'org-1' },
      { type: 'ORGANIZATION', id: 'org-2' },
    ]);
    render(<AuditLogPage />);
    await screen.findByText('No audit entries match these filters.');
    fireEvent.click(screen.getByRole('button', { name: 'Enter an ID instead' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'User id' }), {
      target: { value: ACTOR },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    });
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({ organizationId: 'org-2', limit: 50 }),
    );
  });

  it('shows empty and error states', async () => {
    render(<AuditLogPage />);
    expect(await screen.findByText('No audit entries match these filters.')).toBeInTheDocument();
    mocks.list.mockRejectedValueOnce(
      new AuthApiError('validation', 400, undefined, { code: 'AUDIT_RANGE_TOO_WIDE' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at most 366 days/);
  });

  it('works without organization.read (organizations shown by id) and with no access', async () => {
    mocks.listOrganizations.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<AuditLogPage />);
    const select = await screen.findByRole('combobox', { name: 'Organization' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['org-1']);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    cleanup();

    auth([{ type: 'TEAM', id: 'team-1' }]);
    render(<AuditLogPage />);
    expect(await screen.findByText(/No organizations are within your audit access/)).toBeVisible();
  });
});

describe('TruncatedNotice', () => {
  it('explains a capped list only when truncated', () => {
    expect(truncatedNoticeText(1000)).toBe(
      'Showing the first 1,000 results — narrow the filters to see more.',
    );
    const { rerender } = render(<TruncatedNotice truncated shown={500} />);
    expect(screen.getByRole('note')).toHaveTextContent('Showing the first 500 results');
    rerender(<TruncatedNotice truncated={false} shown={500} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    rerender(<TruncatedNotice shown={500} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
