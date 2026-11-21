'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageContainer } from '../ui/page-container';
import { PermissionGate } from '../ui/require-permission';
import { PageHeader, ErrorBanner, FeedbackMessage, LoadingState } from '../organization/shared';
import { hasPermission } from '../../lib/authorization/can';
import { useAuth } from '../../providers/auth-provider';
import { employeeApi } from '../../lib/employee/api';
import {
  employeeAssignmentActionErrorMessage,
  employeeErrorMessage,
  employeeManagerActionErrorMessage,
  isEmployeeForbidden,
} from '../../lib/employee/errors';
import { formatDateOnly } from '../../lib/employee/date';
import type {
  EmployeeAssignmentView,
  EmployeeCapabilities,
  EmployeeProfile,
  EmployeeTermination,
  EmployeeTerminationResult,
  EmployeeTransferResult,
} from '../../lib/employee/types';
import { offboardingStartHref, onboardingStartHref } from '../../lib/onboarding/offboarding-link';
import { AccessReviewSection, type AccessReviewViewer } from './lifecycle/access-review';
import { TerminationGrantsPanel } from './lifecycle/termination-grants';
import { AssignmentImpactPreview } from './lifecycle/assignment-impact-preview';
import { RehireDialog } from './lifecycle/rehire';
import { StatusChangeDialog } from './lifecycle/status-change';
import {
  ApplyTerminationDialog,
  CancelTerminationDialog,
  ScheduledTerminationBanner,
  TerminationDialog,
  TerminationHistory,
} from './lifecycle/termination';
import { TransferDialog, TransferResultNotice } from './lifecycle/transfer';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { buttonClass } from '../ui/button';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { Detail, displayName, EmployeeStatusBadge } from './employee-shared';
import {
  AssignmentActivateConfirm,
  AssignmentCancelConfirm,
  AssignmentCorrectForm,
  AssignmentCreateForm,
  AssignmentEndForm,
} from './employee-assignment-form';
import { AssignmentActions, type AssignmentActionKind } from './employee-assignment-actions';
import { EmployeeManagerActions } from './employee-manager-actions';
import { EmployeeBenefitsSection } from '../benefits/employee-benefits-section';
import { EmployeeCompensationSection } from '../compensation/employee-compensation-section';
import { EmployeePerformanceSection } from '../performance/employee-performance-section';
import { EmployeeWorkflowsSection } from '../onboarding/employee-workflows-section';
import { EmployeeDocumentsSection } from '../documents/employee-documents-section';
import { EmployeeAttendancePinSection } from '../time/employee-attendance-pin-section';
import { EmployeeLoginAccessSection } from './employee-login-access-section';
import { AssignmentCard, ImpactPanel } from './employee-assignment-card';
import { AssignmentManagerClearConfirm, AssignmentManagerForm } from './employee-manager-form';
import { EmployeeProfileEditForm } from './employee-profile-edit-form';

type ProfileAssignmentActionKind =
  AssignmentActionKind | 'manager' | 'clearManager' | 'transfer' | 'impact';
type LifecycleActionKind =
  | 'terminate'
  | 'reschedule'
  | 'cancelTermination'
  | 'applyTermination'
  | 'rehire'
  | 'inactivate'
  | 'reactivate';

export const EMPLOYEE_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'employment', label: 'Employment' },
  { id: 'compensation', label: 'Compensation' },
  { id: 'time', label: 'Time' },
  { id: 'leave', label: 'Leave' },
  { id: 'benefits', label: 'Benefits' },
  { id: 'documents', label: 'Documents' },
  { id: 'performance', label: 'Performance' },
] as const;
export type EmployeeTab = (typeof EMPLOYEE_TABS)[number]['id'];

/** What the profile shows: capabilities from the API, or the legacy permission checks. */
interface WorkspaceAccess {
  source: 'capabilities' | 'legacy';
  tabs: EmployeeCapabilities['tabs'];
  actions: EmployeeCapabilities['actions'];
  canManageLifecycle: boolean;
  canManageAttendancePin: boolean;
  canManageLoginAccess: boolean;
  canReadOnboarding: boolean;
}

interface LegacyFlags {
  canEditProfile: boolean;
  canManageLifecycle: boolean;
  canManageAssignments: boolean;
  canReadCompensation?: boolean;
  canManageAttendancePin?: boolean;
  canManageLoginAccess?: boolean;
  canReadBenefits?: boolean;
  canReadPerformance?: boolean;
  canReadOnboarding?: boolean;
  canReadDocuments?: boolean;
}

/**
 * Tabs and actions follow GET /employees/:id/capabilities (derived from the same rules as the
 * endpoints behind them). When that is unavailable the profile degrades to the permission
 * checks it always used. Either way the API stays authoritative for every request.
 */
export function resolveEmployeeAccess(
  capabilities: EmployeeCapabilities | null,
  legacy: LegacyFlags,
): WorkspaceAccess {
  if (capabilities) {
    return {
      source: 'capabilities',
      tabs: { ...capabilities.tabs, overview: true, employment: true },
      actions: capabilities.actions,
      // Batch 5C: the employee-wide lifecycle rule (older APIs: the SYSTEM edit rule).
      canManageLifecycle: capabilities.actions.manageLifecycle ?? capabilities.actions.edit,
      canManageAttendancePin: Boolean(legacy.canManageAttendancePin),
      canManageLoginAccess: Boolean(legacy.canManageLoginAccess),
      canReadOnboarding: Boolean(legacy.canReadOnboarding),
    };
  }
  return {
    source: 'legacy',
    tabs: {
      overview: true,
      employment: true,
      compensation: Boolean(legacy.canReadCompensation),
      time: Boolean(legacy.canManageAttendancePin),
      leave: false,
      benefits: Boolean(legacy.canReadBenefits),
      documents: Boolean(legacy.canReadDocuments),
      performance: Boolean(legacy.canReadPerformance),
    },
    actions: {
      edit: legacy.canEditProfile,
      changePosition: legacy.canManageAssignments,
      assignManager: legacy.canManageAssignments,
      addCompensation: false,
      manageDocuments: false,
      startOffboarding: false,
      startOnboarding: false,
    },
    canManageLifecycle: legacy.canManageLifecycle,
    canManageAttendancePin: Boolean(legacy.canManageAttendancePin),
    canManageLoginAccess: Boolean(legacy.canManageLoginAccess),
    canReadOnboarding: Boolean(legacy.canReadOnboarding),
  };
}

export function EmployeeProfilePage({ employeeId }: { employeeId: string }) {
  const { authorization, authorizationLoading, can, identity } = useAuth();
  // Batch 10B: the shared gate (loading in the page's width, then the page or the denied state).
  if (authorizationLoading || !hasPermission(authorization, 'employee.read'))
    return (
      <PermissionGate
        loading={authorizationLoading}
        allowed={false}
        deniedMessage="You do not have permission to view employees."
      >
        {null}
      </PermissionGate>
    );
  return (
    <EmployeeProfileContent
      employeeId={employeeId}
      viewer={{
        userId: identity?.id ?? null,
        // `can` without a scope: a System-level grant (the self-target override).
        systemEmployeeManage: can('employee.manage'),
      }}
      canEditProfile={can('employee.manage')}
      canManageLifecycle={can('employee.manage')}
      canManageAssignments={hasPermission(authorization, 'employee.manage')}
      canReadCompensation={['compensation.read', 'compensation.manage'].some((key) =>
        hasPermission(authorization, key),
      )}
      canManageAttendancePin={hasPermission(authorization, 'time.credential.manage')}
      canManageLoginAccess={hasPermission(authorization, 'employee.account.manage')}
      canReadBenefits={['benefit.read', 'benefit.manage'].some((key) =>
        hasPermission(authorization, key),
      )}
      canReadPerformance={[
        'performance.read',
        'performance.manage',
        'performance.evidence.manage',
      ].some((key) => hasPermission(authorization, key))}
      canReadOnboarding={[
        'onboarding.read',
        'onboarding.manage',
        'offboarding.read',
        'offboarding.manage',
      ].some((key) => hasPermission(authorization, key))}
      canReadDocuments={[
        'document.read',
        'document.confidential.read',
        'document.restricted.read',
        'document.manage',
      ].some((key) => hasPermission(authorization, key))}
    />
  );
}

function EmployeeProfileContent({
  employeeId,
  viewer,
  ...legacy
}: LegacyFlags & { employeeId: string; viewer?: AccessReviewViewer }) {
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [capabilities, setCapabilities] = useState<EmployeeCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const loadProfile = useCallback(async () => {
    const value = await employeeApi.get(employeeId);
    setProfile(value);
    setError(null);
    setForbidden(false);
    return value;
  }, [employeeId]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      // Capabilities are hints: when they cannot be loaded the legacy checks apply.
      const capabilitiesRequest = Promise.resolve()
        .then(() => employeeApi.capabilities(employeeId))
        .then((value) =>
          value && typeof value === 'object' && value.tabs && value.actions ? value : null,
        )
        .catch(() => null);
      Promise.all([employeeApi.get(employeeId), capabilitiesRequest])
        .then(([value, caps]) => {
          if (active) {
            setProfile(value);
            setCapabilities(caps);
            setError(null);
            setForbidden(false);
          }
        })
        .catch((cause) => {
          if (active) {
            setForbidden(isEmployeeForbidden(cause));
            setError(employeeErrorMessage(cause, 'Unable to load this employee.'));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [employeeId]);

  const access = resolveEmployeeAccess(capabilities, legacy);

  return (
    // Batch 10B: the shared page frame; the breadcrumb ("Employees › Employee profile") replaces
    // the old "← Employees" link.
    <PageContainer>
      {loading ? (
        <LoadingState />
      ) : forbidden ? (
        <Forbidden />
      ) : error ? (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">
            {error === 'Employee not found.' ? 'Employee not found' : 'Unable to load employee'}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {error === 'Employee not found.'
              ? 'This employee may not exist or may not be available in your authorized scope.'
              : error}
          </p>
        </div>
      ) : profile ? (
        <ProfileView profile={profile} access={access} onRefresh={loadProfile} viewer={viewer} />
      ) : (
        <ErrorBanner>Unable to load this employee.</ErrorBanner>
      )}
    </PageContainer>
  );
}

/**
 * Batch 10B: the profile's tabs use the shared `useTabParam` (hash mode, writing `#tab` when a
 * tab is picked, as before): `/admin/employees/:id#leave` opens Leave, a hidden tab's hash falls
 * back to Overview, and Back/Forward follow the URL.
 */
function useEmployeeTab(available: readonly EmployeeTab[]) {
  return useTabParam<EmployeeTab>(available, 'overview', { writeHash: true });
}

function ProfileView({
  profile,
  access,
  onRefresh,
  viewer,
}: {
  profile: EmployeeProfile;
  access: WorkspaceAccess;
  onRefresh(): Promise<EmployeeProfile>;
  /** Batch 5E: who is looking (the access review's self-target rule). */
  viewer?: AccessReviewViewer;
}) {
  const fullName = displayName(profile.person);
  const { tabs: tabAccess, actions } = access;
  const canEditProfile = actions.edit;
  const canManageLifecycle = access.canManageLifecycle;
  const canManageAssignments = actions.changePosition;
  const canManageManagers = actions.assignManager;
  const visibleTabs = EMPLOYEE_TABS.filter((tab) => tabAccess[tab.id]);
  const [activeTab, selectTab] = useEmployeeTab(visibleTabs.map((tab) => tab.id));
  const idBase = useTabIdBase('employee');
  const [editing, setEditing] = useState(false);
  const [activeAssignmentAction, setActiveAssignmentAction] = useState<{
    kind: ProfileAssignmentActionKind;
    assignment?: EmployeeAssignmentView;
  } | null>(null);
  const [activeLifecycleAction, setActiveLifecycleAction] = useState<LifecycleActionKind | null>(
    null,
  );
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ReactNode | null>(null);
  const [transferResult, setTransferResult] = useState<EmployeeTransferResult | null>(null);
  const terminationHistory = useTerminationHistory(
    profile.id,
    profile.status,
    profile.terminationDate,
  );
  const scheduledTermination =
    terminationHistory.items.find((item) => item.status === 'SCHEDULED') ?? null;
  const terminationScheduled = profile.status === 'ACTIVE' && Boolean(profile.terminationDate);
  const groups: Array<[string, EmployeeAssignmentView[]]> = [
    ['Current employment', profile.assignments.current],
    ['Upcoming employment', profile.assignments.upcoming],
    ['Employment history', profile.assignments.historical],
    ['Cancelled employment', profile.assignments.cancelled],
  ];
  const hasVisibleEmployment = groups.some(([, assignments]) => assignments.length > 0);
  const managerTarget =
    profile.assignments.current.find((assignment) => assignment.isPrimary) ??
    profile.assignments.current[0] ??
    profile.assignments.upcoming[0] ??
    null;
  // Batch 5E: new assignments only for an ACTIVE employee (the API refuses inactive and
  // terminated ones: EMPLOYEE_NOT_ACTIVE; terminated employees are rehired instead).
  const active = profile.status === 'ACTIVE';
  const currentOrganizations = new Set(
    profile.assignments.current.map((assignment) => assignment.organization.id),
  );
  const offboardingTarget = managerTarget?.status === 'ACTIVE' ? managerTarget : null;
  // Batch 7A: with no active assignment left, the link preselects the most recently ended one
  // (offboarding after the fact), with its end date as the planned last day.
  const endedTarget = offboardingTarget
    ? null
    : ([...profile.assignments.historical]
        .filter((assignment) => assignment.status === 'ENDED')
        .sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0] ?? null);
  const offboardingLinkTarget = offboardingTarget ?? endedTarget;
  // Batch 7A: onboarding starts on a planned or active assignment (an upcoming one first).
  const onboardingTarget =
    profile.assignments.upcoming[0] ??
    profile.assignments.current.find((assignment) => assignment.isPrimary) ??
    profile.assignments.current[0] ??
    null;

  function startAddAssignment() {
    setEditing(false);
    setSuccess(null);
    setTransferResult(null);
    setAssignmentError(null);
    setActiveLifecycleAction(null);
    setActiveAssignmentAction({ kind: 'add' });
    selectTab('employment');
  }

  const contextual: Array<{
    key: string;
    label: string;
    onClick?: () => void;
    href?: string;
    primary?: boolean;
  }> = [
    ...(canEditProfile
      ? [
          {
            key: 'edit',
            label: 'Edit employee',
            onClick: () => {
              setSuccess(null);
              setActiveAssignmentAction(null);
              setActiveLifecycleAction(null);
              setEditing(true);
              selectTab('overview');
            },
          },
        ]
      : []),
    ...(canManageAssignments && active && !terminationScheduled
      ? [
          {
            key: 'changePosition',
            label: hasVisibleEmployment ? 'Change position' : 'Add assignment',
            onClick: startAddAssignment,
          },
        ]
      : []),
    ...(canManageManagers && managerTarget
      ? [
          {
            key: 'assignManager',
            label: 'Assign manager',
            onClick: () => showAssignmentAction('manager', managerTarget),
          },
        ]
      : []),
    ...(actions.addCompensation && tabAccess.compensation
      ? [
          {
            key: 'addCompensation',
            label: 'Add compensation',
            onClick: () => selectTab('compensation'),
          },
        ]
      : []),
    ...(actions.manageDocuments && tabAccess.documents
      ? [
          {
            key: 'manageDocuments',
            label: 'Manage documents',
            onClick: () => selectTab('documents'),
          },
        ]
      : []),
    ...(actions.startOnboarding
      ? [
          {
            key: 'startOnboarding',
            label: 'Start onboarding',
            href: onboardingStartHref({
              employeeId: profile.id,
              organizationId: onboardingTarget?.organization.id ?? null,
              employmentAssignmentId: onboardingTarget?.id ?? null,
            }),
          },
        ]
      : []),
    ...(actions.startOffboarding
      ? [
          {
            key: 'startOffboarding',
            label: 'Start offboarding',
            href: offboardingStartHref({
              employeeId: profile.id,
              organizationId: offboardingLinkTarget?.organization.id ?? null,
              employmentAssignmentId: offboardingLinkTarget?.id ?? null,
              plannedEndDate: profile.terminationDate ?? endedTarget?.endDate ?? null,
            }),
          },
        ]
      : []),
    ...(canManageLifecycle && profile.status === 'ACTIVE' && !terminationScheduled
      ? [
          {
            key: 'inactivate',
            label: 'Mark inactive',
            onClick: () => showLifecycleAction('inactivate'),
          },
        ]
      : []),
    ...(canManageLifecycle && profile.status === 'INACTIVE'
      ? [
          {
            key: 'reactivate',
            label: 'Reactivate',
            onClick: () => showLifecycleAction('reactivate'),
          },
        ]
      : []),
  ];

  async function lifecycleDone(message: ReactNode) {
    setActiveLifecycleAction(null);
    await onRefresh();
    terminationHistory.reload();
    setSuccess(message);
  }

  return (
    <>
      <div className="mt-6">
        <PageHeader eyebrow="Employee" title={fullName} description={profile.employeeNumber}>
          <div className="flex flex-wrap items-center gap-2">
            <EmployeeStatusBadge
              status={profile.status}
              terminationDate={profile.terminationDate}
            />
            {contextual.map((action) =>
              action.href ? (
                <Link
                  key={action.key}
                  href={action.href}
                  className={buttonClass('secondary', 'sm')}
                >
                  {action.label}
                </Link>
              ) : (
                <button
                  key={action.key}
                  type="button"
                  onClick={action.onClick}
                  className={buttonClass('secondary', 'sm')}
                >
                  {action.label}
                </button>
              ),
            )}
            {canManageLifecycle && profile.status !== 'TERMINATED' && !terminationScheduled && (
              <button
                type="button"
                onClick={() => showLifecycleAction('terminate')}
                className={buttonClass('danger', 'sm')}
              >
                Terminate employee
              </button>
            )}
            {canManageLifecycle && profile.status === 'TERMINATED' && (
              <button
                type="button"
                onClick={() => showLifecycleAction('rehire')}
                className={buttonClass('primary', 'sm')}
              >
                Rehire employee
              </button>
            )}
          </div>
        </PageHeader>
      </div>
      {success && (
        <div className="mt-6">
          <FeedbackMessage>{success}</FeedbackMessage>
        </div>
      )}
      {assignmentError && !activeAssignmentAction && (
        <div className="mt-6">
          <ErrorBanner>{assignmentError}</ErrorBanner>
        </div>
      )}
      {terminationScheduled && (
        <ScheduledTerminationBanner
          profile={profile}
          termination={scheduledTermination}
          canManage={canManageLifecycle}
          canStartOffboarding={actions.startOffboarding}
          onReschedule={() => showLifecycleAction('reschedule')}
          onCancel={() => showLifecycleAction('cancelTermination')}
          onApply={() => showLifecycleAction('applyTermination')}
        />
      )}
      {terminationScheduled && canManageLifecycle && scheduledTermination && (
        <TerminationGrantsPanel
          key={scheduledTermination.id}
          employeeId={profile.id}
          termination={scheduledTermination}
          viewerUserId={viewer?.userId ?? null}
        />
      )}
      {transferResult && (
        <TransferResultNotice
          result={transferResult}
          canAddCompensation={actions.addCompensation && tabAccess.compensation}
          onOpenCompensation={() => {
            setTransferResult(null);
            selectTab('compensation');
          }}
          onDismiss={() => setTransferResult(null)}
        />
      )}
      {(activeLifecycleAction === 'terminate' || activeLifecycleAction === 'reschedule') && (
        <TerminationDialog
          open
          profile={profile}
          termination={activeLifecycleAction === 'reschedule' ? scheduledTermination : null}
          onClose={() => setActiveLifecycleAction(null)}
          onDone={(result) =>
            void lifecycleDone(
              terminationMessage(result, actions.startOffboarding, offboardingTarget),
            )
          }
        />
      )}
      {activeLifecycleAction === 'cancelTermination' && scheduledTermination && (
        <CancelTerminationDialog
          open
          profile={profile}
          termination={scheduledTermination}
          onClose={() => setActiveLifecycleAction(null)}
          onDone={() =>
            void lifecycleDone(
              'Scheduled termination cancelled. Each assignment has its original end date again.',
            )
          }
        />
      )}
      {activeLifecycleAction === 'applyTermination' && scheduledTermination && (
        <ApplyTerminationDialog
          open
          profile={profile}
          termination={scheduledTermination}
          onClose={() => setActiveLifecycleAction(null)}
          onDone={(result) =>
            void lifecycleDone(
              result.employee.status === 'TERMINATED'
                ? appliedMessage(result)
                : 'Termination applied where its last day has passed; the remaining assignments end once it has passed in their time zones.',
            )
          }
        />
      )}
      {activeLifecycleAction === 'rehire' && (
        <RehireDialog
          open
          profile={profile}
          onClose={() => setActiveLifecycleAction(null)}
          onDone={() =>
            void lifecycleDone(
              'Employee rehired into the new assignment. Sign-in access and role grants were not restored; review them in the access review.',
            )
          }
        />
      )}
      {(activeLifecycleAction === 'inactivate' || activeLifecycleAction === 'reactivate') && (
        <StatusChangeDialog
          open
          profile={profile}
          mode={activeLifecycleAction}
          onClose={() => setActiveLifecycleAction(null)}
          onDone={(result) =>
            void lifecycleDone(
              result.status === 'INACTIVE'
                ? 'Employee marked inactive. Time capture is paused until reactivation.'
                : 'Employee reactivated.',
            )
          }
        />
      )}
      <div className="mt-8">
        <TabList
          tabs={visibleTabs}
          active={activeTab}
          onChange={selectTab}
          label="Employee sections"
          idBase={idBase}
        />
        <TabPanel idBase={idBase} id={activeTab}>
          {activeTab === 'overview' && (
            <>
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="text-lg font-semibold text-slate-950">Overview</h2>
                <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Detail label="Employee number">{profile.employeeNumber}</Detail>
                  <Detail label="Status">
                    <EmployeeStatusBadge
                      status={profile.status}
                      terminationDate={profile.terminationDate}
                    />
                  </Detail>
                  <Detail label="Hire date">{formatDateOnly(profile.hireDate)}</Detail>
                  {profile.terminationDate && (
                    <Detail label={terminationScheduled ? 'Scheduled last day' : 'Last day'}>
                      {formatDateOnly(profile.terminationDate)}
                    </Detail>
                  )}
                  {currentOrganizations.size > 1 && (
                    <Detail label="Employment">
                      Works in {currentOrganizations.size} organizations
                    </Detail>
                  )}
                  {profile.person.preferredName && profile.person.preferredName !== fullName && (
                    <Detail label="Preferred name">{profile.person.preferredName}</Detail>
                  )}
                  {profile.person.personalEmail && (
                    <Detail label="Personal email">{profile.person.personalEmail}</Detail>
                  )}
                  {profile.person.phone && <Detail label="Phone">{profile.person.phone}</Detail>}
                  {managerTarget?.manager && (
                    <Detail label="Manager">{managerTarget.manager.displayName}</Detail>
                  )}
                  {managerTarget && <Detail label="Position">{managerTarget.position.name}</Detail>}
                </dl>
              </section>
              {editing && (
                <EmployeeProfileEditForm
                  profile={profile}
                  onCancel={() => setEditing(false)}
                  onSaved={async (message) => {
                    await onRefresh();
                    setEditing(false);
                    setSuccess(message);
                  }}
                />
              )}
              {access.canManageLoginAccess && (
                <EmployeeLoginAccessSection employeeId={profile.id} />
              )}
              {(canManageLifecycle || access.canManageLoginAccess) && (
                <AccessReviewSection profile={profile} viewer={viewer} />
              )}
              {access.canReadOnboarding && <EmployeeWorkflowsSection employeeId={profile.id} />}
            </>
          )}
          {activeTab === 'employment' && (
            <>
              {activeAssignmentAction?.kind === 'add' && (
                <div className="mb-8">
                  <AssignmentCreateForm
                    busy={assignmentBusy}
                    error={assignmentError}
                    onCancel={() => setActiveAssignmentAction(null)}
                    onSubmit={(input) =>
                      assignmentMutation(
                        () => employeeApi.createAssignment(profile.id, input),
                        'Assignment added.',
                      )
                    }
                  />
                </div>
              )}
              <section className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold text-slate-950">Employment</h2>
                  {canManageAssignments &&
                    active &&
                    !terminationScheduled &&
                    activeAssignmentAction?.kind !== 'add' && (
                      <button
                        type="button"
                        onClick={startAddAssignment}
                        className={buttonClass('primary', 'sm')}
                      >
                        Add assignment
                      </button>
                    )}
                </div>
                {!hasVisibleEmployment ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
                    No visible employment.
                  </div>
                ) : (
                  groups
                    .filter(([, assignments]) => assignments.length > 0)
                    .map(([title, assignments]) => (
                      <section key={title} className="space-y-3">
                        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                          {assignments.map((assignment) => (
                            <div key={assignment.id} className="space-y-3">
                              <AssignmentCard
                                assignment={assignment}
                                showWarnings={canManageManagers || canManageAssignments}
                              />
                              {(canManageAssignments || canManageManagers) && (
                                <div className="space-y-2">
                                  {canManageAssignments && (
                                    <AssignmentActions
                                      assignment={assignment}
                                      busy={
                                        assignmentBusy &&
                                        activeAssignmentAction?.assignment?.id === assignment.id
                                      }
                                      onCorrect={() => showAssignmentAction('correct', assignment)}
                                      onEnd={() => showAssignmentAction('end', assignment)}
                                      onCancel={() => showAssignmentAction('cancel', assignment)}
                                      onActivate={() =>
                                        showAssignmentAction('activate', assignment)
                                      }
                                      employeeActive={profile.status === 'ACTIVE'}
                                      onTransfer={
                                        assignment.status === 'ACTIVE' &&
                                        profile.status === 'ACTIVE' &&
                                        !terminationScheduled
                                          ? () => showAssignmentAction('transfer', assignment)
                                          : undefined
                                      }
                                      onImpact={
                                        assignment.status === 'ACTIVE'
                                          ? () => showAssignmentAction('impact', assignment)
                                          : undefined
                                      }
                                      onPrimary={() =>
                                        void assignmentMutation(
                                          () =>
                                            employeeApi.setAssignmentPrimary(
                                              profile.id,
                                              assignment.id,
                                              { isPrimary: !assignment.isPrimary },
                                            ),
                                          'Primary assignment updated.',
                                        )
                                      }
                                    />
                                  )}
                                  {canManageManagers && (
                                    <EmployeeManagerActions
                                      assignment={assignment}
                                      busy={
                                        assignmentBusy &&
                                        activeAssignmentAction?.assignment?.id === assignment.id
                                      }
                                      onSet={() => showAssignmentAction('manager', assignment)}
                                      onClear={() =>
                                        showAssignmentAction('clearManager', assignment)
                                      }
                                    />
                                  )}
                                </div>
                              )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'correct' && (
                                  <AssignmentCorrectForm
                                    assignment={assignment}
                                    busy={assignmentBusy}
                                    error={assignmentError}
                                    onCancel={() => setActiveAssignmentAction(null)}
                                    onSubmit={(input) =>
                                      assignmentMutation(
                                        () =>
                                          employeeApi.updateAssignment(
                                            profile.id,
                                            assignment.id,
                                            input,
                                          ),
                                        'Assignment updated.',
                                      )
                                    }
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'end' && (
                                  <AssignmentEndForm
                                    assignment={assignment}
                                    busy={assignmentBusy}
                                    error={assignmentError}
                                    renderPreview={(endDate) => (
                                      <AssignmentImpactPreview
                                        employeeId={profile.id}
                                        assignmentId={assignment.id}
                                        endDate={endDate}
                                        showOffboarding={tabAccess.employment}
                                      />
                                    )}
                                    onCancel={() => setActiveAssignmentAction(null)}
                                    onSubmit={(endDate) =>
                                      assignmentMutation(
                                        () =>
                                          employeeApi.endAssignment(profile.id, assignment.id, {
                                            endDate,
                                          }),
                                        'Assignment ended.',
                                      )
                                    }
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'cancel' && (
                                  <AssignmentCancelConfirm
                                    busy={assignmentBusy}
                                    error={assignmentError}
                                    onCancel={() => setActiveAssignmentAction(null)}
                                    onConfirm={() =>
                                      assignmentMutation(
                                        () =>
                                          employeeApi.cancelAssignment(profile.id, assignment.id),
                                        'Assignment cancelled.',
                                      )
                                    }
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'activate' && (
                                  <AssignmentActivateConfirm
                                    assignment={assignment}
                                    busy={assignmentBusy}
                                    error={assignmentError}
                                    onCancel={() => setActiveAssignmentAction(null)}
                                    onConfirm={() =>
                                      assignmentMutation(
                                        () =>
                                          employeeApi.activateAssignment(profile.id, assignment.id),
                                        'Assignment activated.',
                                      )
                                    }
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'transfer' && (
                                  <TransferDialog
                                    open
                                    profile={profile}
                                    assignment={assignment}
                                    onClose={() => setActiveAssignmentAction(null)}
                                    onDone={(result) => {
                                      setActiveAssignmentAction(null);
                                      setTransferResult(result);
                                      void onRefresh();
                                    }}
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'impact' && (
                                  <ImpactPanel
                                    profile={profile}
                                    assignment={assignment}
                                    onClose={() => setActiveAssignmentAction(null)}
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'manager' && (
                                  <AssignmentManagerForm
                                    assignment={assignment}
                                    busy={assignmentBusy}
                                    error={assignmentError}
                                    onCancel={() => setActiveAssignmentAction(null)}
                                    onSubmit={(manager) =>
                                      assignmentMutation(
                                        () =>
                                          employeeApi.setAssignmentManager(
                                            profile.id,
                                            assignment.id,
                                            { managerAssignmentId: manager.assignmentId },
                                          ),
                                        'Manager updated.',
                                        employeeManagerActionErrorMessage,
                                      )
                                    }
                                  />
                                )}
                              {activeAssignmentAction?.assignment?.id === assignment.id &&
                                activeAssignmentAction.kind === 'clearManager' && (
                                  <AssignmentManagerClearConfirm
                                    busy={assignmentBusy}
                                    error={assignmentError}
                                    onCancel={() => setActiveAssignmentAction(null)}
                                    onConfirm={() =>
                                      assignmentMutation(
                                        () =>
                                          employeeApi.setAssignmentManager(
                                            profile.id,
                                            assignment.id,
                                            { managerAssignmentId: null },
                                          ),
                                        'Manager cleared.',
                                        employeeManagerActionErrorMessage,
                                      )
                                    }
                                  />
                                )}
                            </div>
                          ))}
                        </div>
                      </section>
                    ))
                )}
                {(terminationHistory.items.length > 0 ||
                  terminationHistory.loading ||
                  terminationHistory.error ||
                  profile.terminationDate) && (
                  <TerminationHistory
                    items={terminationHistory.items}
                    loading={terminationHistory.loading}
                    error={terminationHistory.error}
                    onRetry={terminationHistory.reload}
                  />
                )}
              </section>
            </>
          )}
          {activeTab === 'compensation' && <EmployeeCompensationSection employeeId={profile.id} />}
          {activeTab === 'time' && (
            <>
              {access.source === 'capabilities' && (
                <DomainLink
                  title="Attendance"
                  description="Attendance records, exceptions and timesheets for this employee are reviewed in Attendance."
                  href="/admin/time"
                  label="Open Attendance"
                />
              )}
              {access.canManageAttendancePin && (
                <EmployeeAttendancePinSection employeeId={profile.id} />
              )}
            </>
          )}
          {activeTab === 'leave' && (
            // Batch 6B: opens Leave with this employee already selected.
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-slate-950">Leave</h2>
              <p className="mt-1 text-sm text-slate-600">
                Leave requests, approvals and balances for this employee are managed in Leave.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href={`/admin/leave?employeeId=${encodeURIComponent(profile.id)}#requests`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Leave requests
                </Link>
                <Link
                  href={`/admin/leave?employeeId=${encodeURIComponent(profile.id)}#balances`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Leave balances
                </Link>
              </div>
            </section>
          )}
          {activeTab === 'benefits' && <EmployeeBenefitsSection employeeId={profile.id} />}
          {activeTab === 'documents' && <EmployeeDocumentsSection employeeId={profile.id} />}
          {activeTab === 'performance' && <EmployeePerformanceSection employeeId={profile.id} />}
        </TabPanel>
      </div>
    </>
  );

  function showAssignmentAction(
    kind: ProfileAssignmentActionKind,
    assignment: EmployeeAssignmentView,
  ) {
    setEditing(false);
    setSuccess(null);
    setTransferResult(null);
    setAssignmentError(null);
    setActiveLifecycleAction(null);
    setActiveAssignmentAction({ kind, assignment });
    selectTab('employment');
  }

  function showLifecycleAction(kind: LifecycleActionKind) {
    setEditing(false);
    setActiveAssignmentAction(null);
    setAssignmentError(null);
    setSuccess(null);
    setTransferResult(null);
    setActiveLifecycleAction(kind);
  }

  async function assignmentMutation(
    mutate: () => Promise<unknown>,
    message: string,
    errorMessage: (cause: unknown) => string = employeeAssignmentActionErrorMessage,
  ) {
    if (assignmentBusy) return;
    setAssignmentBusy(true);
    setAssignmentError(null);
    setSuccess(null);
    try {
      await mutate();
      await onRefresh();
      setActiveAssignmentAction(null);
      setSuccess(message);
    } catch (cause) {
      setAssignmentError(errorMessage(cause));
    } finally {
      setAssignmentBusy(false);
    }
  }
}

function DomainLink({
  title,
  description,
  href,
  label,
}: {
  title: string;
  description: string;
  href: string;
  label: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <Link href={href} className={`mt-4 ${buttonClass('secondary', 'sm')}`}>
        {label}
      </Link>
    </section>
  );
}

/** The termination history (and the scheduled one's id), reloaded when the status changes. */
function useTerminationHistory(
  employeeId: string,
  status: EmployeeProfile['status'],
  terminationDate: string | null,
) {
  const [items, setItems] = useState<EmployeeTermination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      Promise.resolve()
        .then(() => employeeApi.terminations(employeeId))
        .then((value) => {
          if (!active) return;
          setItems(Array.isArray(value?.items) ? value.items : []);
          setError(null);
        })
        .catch((cause) => {
          if (active)
            setError(employeeErrorMessage(cause, 'Unable to load the termination history.'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [employeeId, status, terminationDate, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { items, loading, error, reload };
}

/** M3: what applying the termination did with the role grants. */
function appliedMessage(result: EmployeeTerminationResult): string {
  const grants = result.grants;
  if (!grants)
    return 'Employee terminated. Sign-in sessions ended; review the role grants in the access review.';
  const parts = [
    `${grants.revoked} role grant${grants.revoked === 1 ? '' : 's'} revoked`,
    ...(grants.retained > 0
      ? [
          `${grants.retained} kept until ${grants.retained === 1 ? 'its' : 'their'} approved end date`,
        ]
      : []),
  ];
  return `Employee terminated. Sign-in sessions ended; ${parts.join(', ')}. See the access review for the login status.`;
}

function terminationMessage(
  result: EmployeeTerminationResult,
  canOffboard: boolean,
  assignment: EmployeeAssignmentView | null,
): ReactNode {
  const scheduled = result.termination.status === 'SCHEDULED';
  return (
    <>
      {scheduled
        ? `Termination scheduled: last day ${formatDateOnly(result.termination.terminationDate)} (inclusive). The employee keeps working until then.`
        : appliedMessage(result)}
      {scheduled && result.applyBlockedBy && (
        <strong className="block">
          It cannot apply until a System administrator decides on, or another one approves, the
          System-level role{result.applyBlockedBy.roleAssignmentIds.length === 1 ? '' : 's'}: until
          then the employee keeps all their access. See “Roles and access at termination”.
        </strong>
      )}
      {canOffboard && (
        <>
          {' '}
          <Link
            href={offboardingStartHref({
              employeeId: result.employee.id,
              organizationId: assignment?.organization.id ?? null,
              employmentAssignmentId: assignment?.id ?? null,
              plannedEndDate: result.termination.terminationDate,
            })}
            className="font-medium underline"
          >
            Review offboarding
          </Link>{' '}
          (it never starts automatically).
        </>
      )}
    </>
  );
}
