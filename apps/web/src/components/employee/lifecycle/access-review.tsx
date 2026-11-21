'use client';

import { checkboxClass } from '../../ui/tokens';

import { useCallback, useEffect, useId, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import {
  employeeLifecycleActionErrorMessage,
  revokeGrantsErrorMessage,
} from '../../../lib/employee/errors';
import { EMPLOYEE_LIFECYCLE_LABELS, employeeLifecycleState } from '../../../lib/employee/lifecycle';
import type {
  EmployeeAccessReview,
  EmployeeProfile,
  EmployeeRevokeGrantsResult,
  GrantInactiveReason,
  GrantRelation,
} from '../../../lib/employee/types';
import { FormDialog } from '../../ui/form-dialog';
import { ErrorState, LoadingText } from '../../ui/states';
import { badgeClass, inputClass, type Tone } from '../../ui/tokens';
import { buttonClass } from '../../ui/button';

const RELATION: Record<GrantRelation, { label: string; tone: Tone; help: string }> = {
  CURRENT_EMPLOYMENT: {
    label: 'Current employment',
    tone: 'success',
    help: 'In an organization where the person still works.',
  },
  ENDED_EMPLOYMENT: {
    label: 'Ended employment',
    tone: 'warning',
    help: 'In an organization where the person no longer works.',
  },
  NO_EMPLOYMENT: {
    label: 'No employment',
    tone: 'warning',
    help: 'In an organization where the person never worked.',
  },
  SYSTEM: {
    label: 'System',
    tone: 'danger',
    help: 'System-wide; reviewed by a System administrator.',
  },
};

/** Batch 5E: grants that authorize nothing while their organization or role is archived. */
const INACTIVE: Record<GrantInactiveReason, { label: string; help: string }> = {
  ORGANIZATION_ARCHIVED: {
    label: 'Inactive: organization archived',
    help: 'Grants nothing while the organization is archived; reactivating it restores the grant.',
  },
  ROLE_ARCHIVED: {
    label: 'Inactive: role archived',
    help: 'Grants nothing while the role is archived.',
  },
};

/**
 * Batch 5E: who is looking. On one's own employment record grants can be revoked only with the
 * System-level employee.manage override (the API refuses otherwise: LIFECYCLE_SELF_TARGET); the
 * screen follows that rule, and the API stays the authority.
 */
export interface AccessReviewViewer {
  /** The signed-in user's id (null when unknown: nothing is hidden, the API decides). */
  userId: string | null;
  /** Holds employee.manage at System scope (the self-target override). */
  systemEmployeeManage: boolean;
}

const UNKNOWN_VIEWER: AccessReviewViewer = { userId: null, systemEmployeeManage: false };

const LOGIN: Record<string, string> = {
  ACTIVE: 'Active',
  DISABLED: 'Disabled',
  INVITED: 'Invited',
  LOCKED: 'Locked',
  ARCHIVED: 'Archived',
};

function formatInstant(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * Batch 5C — the employee's login and role grants (R2/R3). M3: a termination revokes the grants
 * in the organizations it ends when it applies (approved, expiring exceptions are kept and shown
 * with their end date); everything else is revoked here by an authorized administrator. Only grants the caller
 * may see are described; the others are counted. One login serves all of the person's
 * employment, so revoking a grant can affect their work in other organizations.
 */
export function AccessReviewSection({
  profile,
  viewer = UNKNOWN_VIEWER,
}: {
  profile: EmployeeProfile;
  viewer?: AccessReviewViewer;
}) {
  const headingId = useId();
  const [review, setReview] = useState<EmployeeAccessReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<EmployeeRevokeGrantsResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReview(await employeeApi.accessReview(profile.id));
    } catch (cause) {
      setError(employeeLifecycleActionErrorMessage(cause, 'Unable to load the access review.'));
    } finally {
      setLoading(false);
    }
  }, [profile.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, profile.status, profile.terminationDate]);

  const access = review?.access ?? null;
  const employment = employeeLifecycleState(profile.status, profile.terminationDate);
  // Batch 5E: inactive grants (archived organization or role) authorize nothing: they are listed
  // and may be revoked as clean-up, but never count as access.
  const effectiveGrants = (access?.grants ?? []).filter((grant) => !grant.inactiveReason);
  const organizations = new Set(
    effectiveGrants.map((grant) => grant.organizationId).filter(Boolean),
  );
  const employmentOrganizations = new Set(
    [
      ...profile.assignments.current,
      ...profile.assignments.upcoming,
      ...profile.assignments.historical,
    ].map((assignment) => assignment.organization.id),
  );
  const crossOrganization =
    organizations.size > 1 ||
    [...organizations].some((id) => id && !employmentOrganizations.has(id));
  // Batch 5E: one's own employment record — revocation needs the System override.
  const ownRecord = Boolean(access && viewer.userId && access.userId === viewer.userId);
  const selfBlocked = ownRecord && !viewer.systemEmployeeManage;
  const canRevoke = (grant: { revocable: boolean }) => grant.revocable && !selfBlocked;
  const revocable = (access?.grants ?? []).filter(canRevoke);
  const alreadyRevoked = result?.alreadyRevoked ?? [];

  return (
    <section
      aria-labelledby={headingId}
      className="mt-8 space-y-4 rounded-xl border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold text-slate-950">
          Access review
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={buttonClass('ghost', 'sm')}
        >
          Refresh
        </button>
      </div>
      <p className="text-sm text-slate-600">
        Employment status and sign-in access are separate. When a termination applies, it ends
        sessions and revokes the role grants in the organizations it ends, except approved
        exceptions, which are kept until their end date. Review what remains here.
      </p>
      {result && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {result.revoked.length === 0
            ? 'No grants were revoked.'
            : `${result.revoked.length} grant${result.revoked.length === 1 ? '' : 's'} revoked.`}
          {alreadyRevoked.length > 0 &&
            ` ${alreadyRevoked.length} selected grant${alreadyRevoked.length === 1 ? ' had' : 's had'} already been revoked (by someone else, or a moment earlier) and ${alreadyRevoked.length === 1 ? 'was' : 'were'} left as ${alreadyRevoked.length === 1 ? 'it was' : 'they were'}.`}
          {result.loginDisabled
            ? ' No authorization remained, so the login was disabled and its sessions ended.'
            : ''}
        </p>
      )}
      {loading && !review ? (
        <LoadingText>Loading access…</LoadingText>
      ) : error ? (
        <ErrorState title="Access review unavailable" message={error} onRetry={() => void load()} />
      ) : !access ? (
        <p className="text-sm text-slate-700">This employee has no login.</p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Employment
              </dt>
              <dd className="mt-1 text-sm text-slate-900">
                {EMPLOYEE_LIFECYCLE_LABELS[employment]}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Login</dt>
              <dd className="mt-1 text-sm text-slate-900">
                {LOGIN[access.loginStatus] ?? access.loginStatus}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Active sessions
              </dt>
              <dd className="mt-1 text-sm text-slate-900">{access.activeSessions}</dd>
            </div>
          </dl>
          {profile.status === 'TERMINATED' && access.loginStatus === 'DISABLED' && (
            <p role="note" className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
              Employment has ended and no access remained, so the login was disabled. History,
              including pay statements, is kept.
            </p>
          )}
          {profile.status === 'TERMINATED' &&
            access.loginStatus === 'ACTIVE' &&
            (access.hasEffectiveAuthorization ? (
              <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
                Employment has ended but the login is still active because role grants remain
                (another organization&apos;s access, or an approved exception until its end date).
                Review the grants below.
              </p>
            ) : (
              <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
                Employment has ended and the remaining grants authorize nothing (their organization
                or role is archived), but the login is still active. Revoking grants here disables
                it.
              </p>
            ))}
          {selfBlocked && (
            <p role="note" className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
              This is your own employment record. You cannot revoke its grants yourself; ask another
              administrator.
            </p>
          )}
          {ownRecord && !selfBlocked && (
            <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
              This is your own employment record. Revoking its grants uses your System-level
              override and is recorded in the audit log.
            </p>
          )}
          <p role="note" className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
            This login is shared by all of the person&apos;s employment. Revoking a grant can affect
            their work in other organizations.
            {crossOrganization && (
              <strong className="block">Grants here span more than one organization.</strong>
            )}
          </p>
          {access.systemGrants > 0 && (
            <p className="text-sm text-slate-800">
              {access.systemGrants} System-level grant{access.systemGrants === 1 ? '' : 's'}: only a
              System administrator can review {access.systemGrants === 1 ? 'it' : 'them'}.
            </p>
          )}
          {access.grants.length === 0 ? (
            <p className="text-sm text-slate-600">No grants you can see.</p>
          ) : (
            <fieldset>
              <legend className="sr-only">Role grants</legend>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {access.grants.map((grant) => {
                  const relation = RELATION[grant.relation];
                  const inactive = grant.inactiveReason ? INACTIVE[grant.inactiveReason] : null;
                  const selectable = canRevoke(grant);
                  const checkboxId = `grant-${grant.roleAssignmentId}`;
                  return (
                    <li
                      key={grant.roleAssignmentId}
                      className="flex flex-wrap items-start gap-3 p-3 text-sm"
                    >
                      {selectable ? (
                        <input
                          id={checkboxId}
                          type="checkbox"
                          checked={selected.includes(grant.roleAssignmentId)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, grant.roleAssignmentId]
                                : current.filter((id) => id !== grant.roleAssignmentId),
                            )
                          }
                          className={`${checkboxClass} mt-1`}
                        />
                      ) : (
                        <span aria-hidden="true" className="mt-1 inline-block w-[13px]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <label
                          htmlFor={selectable ? checkboxId : undefined}
                          className="block break-words font-medium text-slate-950"
                        >
                          {grant.roleName}
                        </label>
                        <p className="break-words text-slate-600">
                          {grant.organizationName ?? 'All organizations'} ·{' '}
                          {grant.scopeType.toLowerCase().replace(/_/g, ' ')}
                        </p>
                        <p className="text-xs text-slate-600">
                          {inactive ? inactive.help : relation.help}
                        </p>
                        {grant.retention && (
                          <p className="text-xs font-medium text-amber-900">
                            Kept after termination until {formatInstant(grant.retention.keepUntil)}{' '}
                            (exception{' '}
                            {grant.retention.approvalStatus === 'APPROVED'
                              ? 'approved by another administrator'
                              : grant.retention.approvalStatus.toLowerCase()}
                            ). It ends automatically; the login is then disabled if nothing else
                            remains.
                          </p>
                        )}
                        {!grant.revocable && (
                          <p className="text-xs text-slate-600">
                            You cannot revoke this grant here.
                          </p>
                        )}
                      </div>
                      <span className="flex flex-wrap gap-1">
                        {inactive && (
                          <span className={badgeClass('neutral')}>{inactive.label}</span>
                        )}
                        {grant.retention && (
                          <span className={badgeClass('warning')}>Kept until end date</span>
                        )}
                        <span className={badgeClass(relation.tone)}>{relation.label}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
          {(access.revokedByTermination?.length ?? 0) > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Revoked by termination</h3>
              <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {access.revokedByTermination!.map((grant) => (
                  <li key={grant.roleAssignmentId} className="p-3 text-sm">
                    <span className="break-words font-medium text-slate-950">{grant.roleName}</span>
                    <span className="block break-words text-slate-600">
                      {grant.organizationName ?? 'All organizations'} ·{' '}
                      {grant.scopeType.toLowerCase().replace(/_/g, ' ')}
                      {grant.revokedAt ? ` · revoked ${formatInstant(grant.revokedAt)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {access.hiddenGrants > 0 && (
            <p className="text-sm text-slate-600">
              {access.hiddenGrants} more grant{access.hiddenGrants === 1 ? '' : 's'} outside your
              access {access.hiddenGrants === 1 ? 'is' : 'are'} not shown.
            </p>
          )}
          {revocable.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={selected.length === 0}
                onClick={() => setConfirming(true)}
                className={buttonClass('danger', 'sm')}
              >
                Revoke selected ({selected.length})
              </button>
              <p className="text-xs text-slate-600">Nothing is revoked until you confirm.</p>
            </div>
          )}
        </>
      )}
      {confirming && access && (
        <RevokeGrantsDialog
          profile={profile}
          ownRecord={ownRecord}
          grants={access.grants.filter((grant) => selected.includes(grant.roleAssignmentId))}
          onClose={() => setConfirming(false)}
          onDone={(value) => {
            setConfirming(false);
            setSelected([]);
            setResult(value);
            void load();
          }}
        />
      )}
    </section>
  );
}

function RevokeGrantsDialog({
  profile,
  ownRecord,
  grants,
  onClose,
  onDone,
}: {
  profile: EmployeeProfile;
  ownRecord: boolean;
  grants: NonNullable<EmployeeAccessReview['access']>['grants'];
  onClose(): void;
  onDone(result: EmployeeRevokeGrantsResult): void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Revoke ${grants.length} grant${grants.length === 1 ? '' : 's'}?`}
      description={`${
        profile.status === 'TERMINATED'
          ? 'If no authorization remains afterwards, the login is disabled and its sessions end.'
          : 'The employee keeps their login; only these grants are removed.'
      } Every selected grant is checked first: if any cannot be revoked, none is.${
        ownRecord ? ' This is your own record: your System-level override is recorded.' : ''
      }`}
      submitLabel="Revoke grants"
      busyLabel="Revoking…"
      busy={busy}
      canSubmit
      error={error}
      tone="destructive"
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          onDone(
            await employeeApi.revokeGrants(profile.id, {
              roleAssignmentIds: grants.map((grant) => grant.roleAssignmentId),
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            }),
          );
        } catch (cause) {
          setError(revokeGrantsErrorMessage(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <ul className="list-disc pl-5 text-sm text-slate-800">
        {grants.map((grant) => (
          <li key={grant.roleAssignmentId} className="break-words">
            {grant.roleName} · {grant.organizationName ?? 'All organizations'}
          </li>
        ))}
      </ul>
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
          Reason <span className="font-normal text-slate-600">(optional)</span>
        </label>
        <textarea
          id={reasonId}
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
      </div>
    </FormDialog>
  );
}
