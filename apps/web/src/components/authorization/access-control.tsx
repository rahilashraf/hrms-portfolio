'use client';

import { checkboxClass } from '../ui/tokens';

import { PageHeader } from '../ui/page-header';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { AuthApiError } from '../../lib/auth/types';
import { authErrorMessage } from '../../lib/auth/error-message';
import { sharedErrorMessage } from '../../lib/features/errors';
import { authorizationApi } from '../../lib/authorization/api';
import type {
  ActiveUser,
  Assignment,
  Permission,
  Role,
  RoleTemplate,
  ScopeType,
} from '../../lib/authorization/types';
import { organizationApi } from '../../lib/organization/api';
import type { Organization } from '../../lib/organization/types';
import { useAuth } from '../../providers/auth-provider';
import { PermissionGate, RequirePermission } from '../ui/require-permission';
import { PageContainer } from '../ui/page-container';
import { StatusBadge } from '../ui/status-badge';
import { badgeClass, buttonClass, inputClass } from '../ui/tokens';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useConfirm } from '../ui/use-confirm';
import { useOptionalWorkspace } from '../../providers/workspace-provider';
import {
  PermissionPicker,
  RoleTemplatePicker,
  grantableTemplatePermissions,
  notGrantableKeys,
} from './role-templates';
import { useToast } from '../ui/toast';
import { scopeTypeLabel } from '../../lib/ui/labels';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from '../../lib/forms/zod';
import { applyApiErrors } from '../../lib/forms/api-errors';
import { optionalText, requiredText } from '../../lib/forms/schemas';
import { InputField, SubmitButton } from '../ui/form/form-field';
import { userSource } from '../../lib/pickers/sources';
import { RecordCombobox } from '../ui/record-combobox';

const scopeTypes: ScopeType[] = ['ORGANIZATION', 'ORGANIZATIONAL_UNIT', 'DEPARTMENT', 'TEAM'];
/** Batch 10B: words for an API refusal (it used to show the raw category, e.g. "forbidden"). */
export function accessErrorMessage(
  error: unknown,
  notFound = 'The requested record was not found. It may have been removed.',
): string {
  if (error instanceof AuthApiError) {
    const shared = sharedErrorMessage(error);
    if (shared) return shared;
    if (error.validationMessage) return error.validationMessage;
    if (error.status === 404) return notFound;
    if (error.status === 0 || error.status >= 500)
      return 'The service is temporarily unavailable. Please try again later.';
    return authErrorMessage(error);
  }
  return error instanceof Error ? error.message : 'Unable to complete request.';
}

function ErrorText({ error, notFound }: { error: unknown; notFound?: string }) {
  return error ? (
    <p role="alert" className="mt-3 text-sm text-rose-700">
      {accessErrorMessage(error, notFound)}
    </p>
  ) : null;
}
const linkClass =
  'font-medium text-[var(--hrms-accent-text)] underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] rounded';

/**
 * Batch 10B: the access-control pages share one frame. On role details the breadcrumb links back
 * to Roles (the old "← Roles & Permissions" link repeated it).
 */
function Shell({
  children,
  title,
  backToRoles = false,
}: {
  children: ReactNode;
  title: string;
  /** User Access is reached from People, so its breadcrumb does not lead back to Roles. */
  backToRoles?: boolean;
}) {
  return (
    <PageContainer width="wide">
      {backToRoles && (
        <Link
          href="/admin/access-control/roles"
          className={`mb-5 inline-block text-sm ${linkClass}`}
        >
          ← Roles & Permissions
        </Link>
      )}
      <PageHeader title={title} />
      {children}
    </PageContainer>
  );
}

/**
 * Batch 10B: while the caller's permissions or the role are loading, a loading state in the
 * page's own width (never "Access denied" first). Presentation only — the API checks every
 * request.
 */
function AccessLoading({ authorizationLoading }: { authorizationLoading: boolean }) {
  return (
    <PermissionGate
      loading
      allowed={false}
      width="wide"
      loadingLabel={authorizationLoading ? undefined : 'Loading role…'}
    >
      {null}
    </PermissionGate>
  );
}

function AccessDenied() {
  return (
    <PermissionGate loading={false} allowed={false} width="wide">
      {null}
    </PermissionGate>
  );
}

/** Mirrors RoleCreateDto: code 2–64 of A–Z, 0–9, - and _; name 1–200; description ≤ 2000. */
const roleFormSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Use at least 2 characters.')
    .max(64, 'Use at most 64 characters.')
    .regex(/^[A-Za-z0-9_-]+$/, 'Use only letters, digits, - and _.'),
  name: requiredText('a name', 200),
  description: optionalText(2000),
});
type RoleFormValues = z.input<typeof roleFormSchema>;
type RoleFormParsed = z.output<typeof roleFormSchema>;

/**
 * Batch 10A: while permissions load the page shows a loading state in its own width (it used to
 * flash "Access denied" first). Presentation only — the API checks every role request.
 */
export function RolesPage() {
  return (
    <RequirePermission anyOf={['role.read']} width="wide">
      <RolesPageContent />
    </RequirePermission>
  );
}

function RolesPageContent() {
  const { can, authorization } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [chosenOrgId, setOrgId] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [include, setInclude] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const roleForm = useForm<RoleFormValues, unknown, RoleFormParsed>({
    resolver: zodResolver(roleFormSchema),
    defaultValues: { code: '', name: '', description: '' },
  });
  const [created, setCreated] = useState<string | null>(null);
  const orgSelectId = useId();
  const workspace = useOptionalWorkspace();
  const workspaceOrgId = workspace?.selectedOrganization?.id ?? '';
  const workspaceOrgs = workspace?.organizations;
  // Defaults to the organization selected in the shell when it is in the list.
  const orgId = chosenOrgId || (orgs.some((o) => o.id === workspaceOrgId) ? workspaceOrgId : '');
  useEffect(() => {
    const scopedIds = new Set(
      authorization?.permissions
        .filter((p) => p.key === 'role.read')
        .flatMap((p) => p.scopes)
        .filter((scope) => scope.type === 'ORGANIZATION' && scope.id)
        .map((scope) => scope.id as string) ?? [],
    );
    if (can('organization.read')) {
      organizationApi.listOrganizations(true).then(setOrgs).catch(setError);
    } else {
      // Batch 10B: without organization.read the names come from the caller's own workspace
      // (organizations they already belong to), so the list shows names rather than raw ids.
      const timer = window.setTimeout(
        () =>
          setOrgs(
            [...scopedIds].map(
              (id) =>
                ({
                  id,
                  name: workspaceOrgs?.find((org) => org.id === id)?.name ?? id,
                }) as Organization,
            ),
          ),
        0,
      );
      return () => window.clearTimeout(timer);
    }
  }, [authorization, can, workspaceOrgs]);
  const manage = orgId ? can('role.manage', { type: 'ORGANIZATION', id: orgId }) : false;
  useEffect(() => {
    if (orgId) {
      authorizationApi.roles(orgId, include).then(setRoles).catch(setError);
      authorizationApi.permissions(orgId).then(setPermissions).catch(setError);
    }
  }, [orgId, include]);
  useEffect(() => {
    if (!orgId || !manage) return;
    let active = true;
    authorizationApi
      .roleTemplates(orgId)
      // Templates are presets only; the reserved System Owner is never one.
      .then((items) => {
        if (active) setTemplates(items.filter((item) => item.key !== 'SYSTEM_OWNER'));
      })
      .catch(() => {
        if (active) setTemplates([]);
      });
    return () => {
      active = false;
    };
  }, [orgId, manage]);
  const canReadOrg = orgId ? can('role.read', { type: 'ORGANIZATION', id: orgId }) : false;
  const blocked = notGrantableKeys(templates);
  function applyTemplate(key: string) {
    setTemplateKey(key);
    const template = templates.find((item) => item.key === key);
    if (template) setSelectedPermissions(grantableTemplatePermissions(template));
  }
  const create = roleForm.handleSubmit(async (values) => {
    if (!orgId) return;
    setCreated(null);
    setError(undefined);
    try {
      const role = await authorizationApi.createRole(orgId, {
        code: values.code,
        name: values.name,
        // Unchanged from before: an empty description is sent as ''.
        description: values.description ?? '',
        permissionKeys: selectedPermissions.filter((key) => !blocked.has(key)),
      });
      roleForm.reset();
      setSelectedPermissions([]);
      setTemplateKey('');
      setCreated(role?.name ?? values.name);
      setRoles(await authorizationApi.roles(orgId, include));
    } catch (cause) {
      // Field-level refusals (e.g. a code already used) go on the field; the rest above the list.
      const outcome = applyApiErrors(cause, roleForm.setError, {
        fields: { code: 'code', name: 'name', description: 'description' },
      });
      if (outcome.placed === 0 || outcome.message) setError(cause);
    }
  });
  const roleErrors = roleForm.formState.errors;
  return (
    <Shell title="Roles">
      {/* Batch 10B (D6): the select fills a phone's width instead of widening the page. */}
      <div className="mt-6 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="w-full min-w-0 sm:w-auto">
          <label htmlFor={orgSelectId} className="text-sm font-medium text-slate-700">
            Organization
          </label>
          <select
            id={orgSelectId}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            className={`${inputClass} sm:w-auto sm:min-w-64 sm:max-w-md`}
          >
            <option value="">Choose organization</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 py-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={include}
            onChange={(e) => setInclude(e.target.checked)}
          />{' '}
          Include archived
        </label>
      </div>
      <ErrorText error={error} />
      {canReadOrg && manage && orgId && (
        <form
          aria-label="Create role"
          noValidate
          onSubmit={(e) => void create(e)}
          className="mt-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <InputField
              label="Code"
              required
              hint="2–64 letters, digits, - or _."
              error={roleErrors.code?.message}
              autoComplete="off"
              registration={roleForm.register('code')}
            />
            <InputField
              label="Name"
              required
              error={roleErrors.name?.message}
              registration={roleForm.register('name')}
            />
            <InputField
              label="Description"
              error={roleErrors.description?.message}
              registration={roleForm.register('description')}
            />
          </div>
          {templates.length > 0 && (
            <RoleTemplatePicker
              templates={templates}
              selectedKey={templateKey}
              onSelect={applyTemplate}
            />
          )}
          <PermissionPicker
            legend="Permissions"
            permissions={permissions}
            selected={selectedPermissions}
            onChange={setSelectedPermissions}
            notGrantable={blocked}
          />
          <div>
            <SubmitButton busy={roleForm.formState.isSubmitting} busyLabel="Creating…">
              Create role
            </SubmitButton>
          </div>
        </form>
      )}
      {created && (
        <p role="status" className="mt-3 text-sm text-emerald-800">
          Role {created} created. Open it to review or change its permissions at any time.
        </p>
      )}
      {roles.length > 0 && (
        <ul
          aria-label="Roles"
          className="mt-6 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white"
        >
          {roles.map((role) => (
            <li
              key={role.id}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {role.isSystemOwner ? (
                    <span className="break-words font-medium text-slate-900">{role.name}</span>
                  ) : (
                    <Link
                      className={`break-words ${linkClass}`}
                      href={`/admin/access-control/roles/${role.id}`}
                    >
                      {role.name}
                    </Link>
                  )}
                  {role.isSystemOwner && <span className={badgeClass('neutral')}>Protected</span>}
                  <StatusBadge status={role.archivedAt ? 'ARCHIVED' : 'ACTIVE'} />
                </div>
                <p className="mt-1 break-words text-sm text-slate-600">
                  {role.code} · {role.permissions?.length ?? 0} permissions ·{' '}
                  {role.description || 'No description'}
                </p>
              </div>
              <Link
                className={`shrink-0 text-sm ${linkClass}`}
                href={`/admin/access-control/assignments?roleId=${role.id}`}
              >
                User access
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function RoleDetailPage({ roleId }: { roleId: string }) {
  const { can, authorizationLoading } = useAuth();
  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  /** The role could not be loaded (the page has nothing to show). */
  const [loadError, setLoadError] = useState<unknown>();
  /** A later request failed (shown above the page, which stays usable). */
  const [error, setError] = useState<unknown>();
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  useEffect(() => {
    authorizationApi
      .role(roleId)
      .then((r) => {
        setRole(r);
        setName(r.name);
        setDescription(r.description ?? '');
        setSelected(r.permissions?.map((p) => p.permission.key) ?? []);
        if (r.organizationId)
          authorizationApi.permissions(r.organizationId).then(setPermissions).catch(setError);
      })
      .catch(setLoadError);
  }, [roleId]);
  // Batch 10B: loading (permissions or role), API error and denied are distinct states.
  if (authorizationLoading || (!role && !loadError))
    return <AccessLoading authorizationLoading={authorizationLoading} />;
  if (!role)
    return (
      <Shell title="Role">
        <ErrorText
          error={loadError}
          notFound="This role was not found. It may have been removed."
        />
      </Shell>
    );
  if (role.organizationId && !can('role.read', { type: 'ORGANIZATION', id: role.organizationId }))
    return <AccessDenied />;
  const currentRole = role;
  // The reserved System Owner role is protected: never editable here.
  const manage =
    !currentRole.isSystemOwner &&
    can('role.manage', {
      type: 'ORGANIZATION',
      id: currentRole.organizationId ?? '',
    });
  async function saveMetadata(event: FormEvent) {
    event.preventDefault();
    try {
      await authorizationApi.updateRole(roleId, { name, description });
      setRole(await authorizationApi.role(roleId));
      setError(undefined);
      // Batch 10B: a transient confirmation (errors stay inline above the form).
      toast.success('Role details saved.');
    } catch (e) {
      setError(e);
    }
  }
  async function savePermissions() {
    try {
      await authorizationApi.replacePermissions(roleId, selected);
      setRole(await authorizationApi.role(roleId));
      setError(undefined);
      toast.success('Permissions saved.');
    } catch (e) {
      setError(e);
    }
  }
  async function toggle() {
    if (
      !currentRole.archivedAt &&
      !(await confirm({
        title: `Archive role ${currentRole.name}?`,
        description:
          'Current and future assignments of this role will be revoked. Reactivating the role later will not restore them.',
        confirmLabel: 'Archive role',
      }))
    )
      return;
    try {
      if (currentRole.archivedAt) await authorizationApi.reactivate(roleId);
      else await authorizationApi.archive(roleId);
      setRole(await authorizationApi.role(roleId));
      setError(undefined);
      toast.success(currentRole.archivedAt ? 'Role reactivated.' : 'Role archived.');
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Shell title={currentRole.name}>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span className="break-all">{currentRole.code}</span>
        <StatusBadge status={currentRole.archivedAt ? 'ARCHIVED' : 'ACTIVE'} />
        {currentRole.isSystemOwner && <span className={badgeClass('neutral')}>Protected</span>}
      </div>
      <ErrorText error={error} />
      {currentRole.isSystemOwner && (
        <p role="note" className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          This is the reserved System Owner role. It is protected and cannot be edited, archived or
          used as a template.
        </p>
      )}
      <form
        onSubmit={(e) => void saveMetadata(e)}
        className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-white p-5"
      >
        <label className="text-sm font-medium text-slate-700">
          Name
          <input
            disabled={!manage}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${inputClass} sm:max-w-md`}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Description
          <textarea
            disabled={!manage}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </label>
        {manage && <button className={`w-fit ${buttonClass('primary')}`}>Save details</button>}
      </form>
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">Permissions</h2>
        <PermissionPicker
          legend="Role permissions"
          hideLegend
          permissions={permissions}
          selected={selected}
          onChange={setSelected}
          disabled={!manage}
        />
        {manage && (
          <button
            onClick={() => void savePermissions()}
            className={`mt-5 ${buttonClass('primary')}`}
          >
            Save permissions
          </button>
        )}
      </section>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        {manage && (
          <button
            onClick={() => void toggle()}
            className={buttonClass(currentRole.archivedAt ? 'secondary' : 'danger')}
          >
            {currentRole.archivedAt ? 'Reactivate' : 'Archive role'}
          </button>
        )}
        <Link
          className={linkClass}
          href={`/admin/access-control/assignments?roleId=${currentRole.id}`}
        >
          Manage user access →
        </Link>
      </div>
      {confirmDialog}
    </Shell>
  );
}

export function AssignmentsPage({ roleId }: { roleId: string }) {
  const { can, authorizationLoading } = useAuth();
  const [role, setRole] = useState<Role | null>(null);
  const [loadError, setLoadError] = useState<unknown>();
  const [items, setItems] = useState<Assignment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [scopeType, setScopeType] = useState<ScopeType>('ORGANIZATION');
  const [scopeId, setScopeId] = useState('');
  const [scopeOptions, setScopeOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [userId, setUserId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<unknown>();
  const [revoking, setRevoking] = useState<Assignment | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const scopeTypeId = useId();
  const scopeSelectId = useId();
  const toast = useToast();
  useEffect(() => {
    authorizationApi
      .role(roleId)
      .then((r) => {
        setRole(r);
        setOrgId(r.organizationId ?? '');
      })
      .catch(setLoadError);
  }, [roleId]);
  const loadAssignments = useCallback(
    async (afterId?: string) => {
      const result = await authorizationApi.assignments(roleId, includeRevoked, afterId);
      setItems((current) => (afterId ? [...current, ...result.items] : result.items));
      setNextCursor(result.nextCursor);
    },
    [roleId, includeRevoked],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void loadAssignments().catch(setError), 0);
    return () => window.clearTimeout(timer);
  }, [loadAssignments]);
  // Batch 3B: the shared record picker (debounced, paged, stale answers ignored).
  const userSearch = useMemo(() => (orgId ? userSource(orgId) : null), [orgId]);
  useEffect(() => {
    if (!orgId) return;
    const load =
      scopeType === 'ORGANIZATION'
        ? Promise.resolve([{ id: orgId, name: 'Organization' }])
        : scopeType === 'ORGANIZATIONAL_UNIT'
          ? organizationApi.listUnits(orgId)
          : scopeType === 'DEPARTMENT'
            ? organizationApi.listDepartments(orgId)
            : organizationApi.listTeams(orgId);
    load.then(setScopeOptions).catch(setError);
  }, [orgId, scopeType]);
  // Batch 10B: loading (permissions or role), API error and denied are distinct states.
  if (authorizationLoading || (!role && !loadError))
    return <AccessLoading authorizationLoading={authorizationLoading} />;
  if (!role)
    return (
      <Shell backToRoles title="User Access">
        <ErrorText
          error={loadError}
          notFound="This role was not found. It may have been removed."
        />
      </Shell>
    );
  if (
    !role.organizationId ||
    !can('role.read', { type: 'ORGANIZATION', id: role.organizationId }) ||
    !can('role.assign', { type: 'ORGANIZATION', id: role.organizationId })
  )
    return <AccessDenied />;
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!userId) {
      setError(new Error('Choose a user.'));
      return;
    }
    if (expiresAt && startsAt && new Date(expiresAt) <= new Date(startsAt)) {
      setError(new Error('Expiration must be later than the start date.'));
      return;
    }
    try {
      await authorizationApi.createAssignment({
        userId,
        roleId,
        scope: { type: scopeType, id: scopeId },
        startsAt: startsAt || undefined,
        expiresAt: expiresAt || null,
      });
      await loadAssignments();
    } catch (x) {
      setError(x);
    }
  }
  return (
    <Shell backToRoles title={`User Access · ${role.name}`}>
      <ErrorText error={error} />
      <label className="mt-5 flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={includeRevoked}
          onChange={(e) => setIncludeRevoked(e.target.checked)}
        />{' '}
        Show revoked access
      </label>
      <form
        aria-label="Assign role"
        onSubmit={(e) => void add(e)}
        className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2"
      >
        {userSearch && (
          <RecordCombobox
            className="sm:col-span-2"
            label="Find user (name, email or employee number)"
            hint="Lists people who work in, or hold a role in, an organization where you manage access."
            required
            source={userSearch}
            value={userId}
            onChange={(id) => setUserId(id)}
            placeholder="Type a name, email or employee number"
            noResultsText="No matching people in the organizations where you manage access."
          />
        )}
        <div className="min-w-0">
          <label htmlFor={scopeTypeId} className="text-sm font-medium text-slate-700">
            Scope
          </label>
          <select
            id={scopeTypeId}
            value={scopeType}
            onChange={(e) => {
              setScopeType(e.target.value as ScopeType);
              setScopeId('');
            }}
            className={inputClass}
          >
            {scopeTypes.map((t) => (
              <option key={t} value={t}>
                {scopeTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={scopeSelectId} className="text-sm font-medium text-slate-700">
            {scopeTypeLabel(scopeType)}
          </label>
          <select
            id={scopeSelectId}
            required
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className={inputClass}
          >
            <option value="">Select scope</option>
            {scopeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <label className="min-w-0 text-sm font-medium text-slate-700">
          Starts at
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="min-w-0 text-sm font-medium text-slate-700">
          Expires at
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className={inputClass}
          />
        </label>
        <div className="sm:col-span-2">
          <button className={buttonClass('primary')}>Assign role</button>
        </div>
      </form>
      {items.length > 0 && (
        <ul
          aria-label="People with this role"
          className="mt-6 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white"
        >
          {items.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="break-all font-medium text-slate-900">
                  {a.user?.email ?? a.userId}
                </span>
                <span className="text-slate-600">{scopeTypeLabel(a.scopeType)}</span>
                <StatusBadge status={a.revokedAt ? 'REVOKED' : 'ACTIVE'} />
                {a.expiresAt && (
                  <span className="text-slate-600">
                    expires {new Date(a.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              {!a.revokedAt && (
                <button
                  type="button"
                  className={`shrink-0 self-start sm:self-auto ${buttonClass('danger', 'sm')}`}
                  aria-label={`Revoke for ${a.user?.email ?? a.userId}`}
                  onClick={() => setRevoking(a)}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button
          onClick={() => void loadAssignments(nextCursor)}
          className={`mt-4 ${buttonClass('secondary')}`}
        >
          Load more
        </button>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke user access?"
        description={
          <>
            {revoking?.user?.email ?? revoking?.userId} loses this role&apos;s permissions
            immediately. The access record is kept for audit and can be granted again later.
          </>
        }
        confirmLabel="Revoke access"
        busy={revokeBusy}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (!revoking) return;
          setRevokeBusy(true);
          void authorizationApi
            .revoke(revoking.id)
            .then(() => loadAssignments())
            .then(() => toast.success('Access revoked.'))
            .catch(setError)
            .finally(() => {
              setRevokeBusy(false);
              setRevoking(null);
            });
        }}
      />
    </Shell>
  );
}

/** "Ada Lovelace (EMP-000006) · ada@example.com · invited" for the user picker. */
export function userOptionLabel(user: ActiveUser): string {
  const name = user.displayName
    ? `${user.displayName}${user.employeeNumber ? ` (${user.employeeNumber})` : ''} · `
    : user.employeeNumber
      ? `${user.employeeNumber} · `
      : '';
  return `${name}${user.email}${user.status === 'INVITED' ? ' · invited (roles apply after activation)' : ''}`;
}
