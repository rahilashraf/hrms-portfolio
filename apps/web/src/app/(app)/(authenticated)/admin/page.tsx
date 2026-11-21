'use client';

import Link from 'next/link';
import { OrganizationListPage } from '../../../../components/organization/organization-list';
import { RequirePermission } from '../../../../components/ui/require-permission';
import { hasPermission } from '../../../../lib/authorization/can';
import { useAuth } from '../../../../providers/auth-provider';

/**
 * Administration home: the organization directory, with a shortcut to roles for role managers.
 * Batch 10A: the page heading (h1) comes first and the shortcut follows it as a section (h2); the
 * shortcut uses the organization's brand colors; while permissions load the page shows a loading
 * state in its own width (never a flash of "No organization access").
 */
export default function AdminPage() {
  const { authorization } = useAuth();
  // Role readers keep their shortcut even without organization access (shown after the h1 of
  // either the directory or the denied state). Batch R3.2: the Roles page requires role.read, so
  // the shortcut does too (role.manage alone used to lead to "Access denied"), with the page's own
  // check: role.read at any scope (a scope-less can() would count only system-wide grants).
  const rolesShortcut = hasPermission(authorization, 'role.read') ? (
    <Link
      href="/admin/access-control/roles"
      className="block rounded-xl border border-slate-200 bg-white p-5 text-left hover:bg-slate-50"
    >
      <h2 className="font-semibold text-[var(--hrms-accent-text)]">Roles &amp; Permissions</h2>
      <p className="mt-1 text-sm text-slate-600">
        Organization roles, their permissions, and scoped assignments.
      </p>
    </Link>
  ) : null;
  return (
    <RequirePermission
      anyOf={['organization.read']}
      deniedTitle="No organization access"
      deniedMessage="You do not have permission to view organizations."
      deniedExtra={rolesShortcut}
    >
      <OrganizationListPage intro={rolesShortcut} />
    </RequirePermission>
  );
}
