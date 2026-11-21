'use client';

import {
  setLocationSearchParam,
  useTabParam,
  useLocationSearch,
} from '../../lib/navigation/use-location-hash';
import { useCallback, useId, useState } from 'react';
import { PageContainer } from '../ui/page-container';
import { PermissionGate } from '../ui/require-permission';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { hasPermission } from '../../lib/authorization/can';
import { useAuth } from '../../providers/auth-provider';
import { timeApi } from '../../lib/time/api';
import { timeErrorMessage } from '../../lib/time/errors';
import { formatDateOnly } from '../../lib/time/format';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { inputClass } from '../ui/tokens';
import { AttendanceAdmin } from './attendance-admin';
import { RecordsTable } from './employee-time-page';
import { AttendanceOverview, type ReviewTab } from './review/attendance-overview';
import { CorrectionReview } from './review/correction-review';
import { ExceptionReview } from './review/exception-review';
import {
  DateField,
  HistoricalNotice,
  HistoricalToggle,
  historyQuery,
  isHistoricalOrganization,
  LoadMore,
  OrganizationPicker,
  ReviewPanel,
  useDebounced,
  usePagedList,
  useReviewOrganizations,
  type ReviewOrganization,
} from './review/review-shared';
import { ScheduledVsActual } from './review/scheduled-vs-actual';
import { TimesheetReview } from './review/timesheet-review';

type Tab = ReviewTab;

/** Phase 9.5 — attendance administration (sign-ins, kiosks, policies); PINs live on the profile. */
const ATTENDANCE_ADMIN_PERMISSIONS = [
  'time.view',
  'time.correct',
  'time.manage_policy',
  'time.device.manage',
] as const;

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  records: 'Records',
  exceptions: 'Exceptions',
  corrections: 'Corrections',
  timesheets: 'Timesheets',
  scheduled: 'Scheduled vs actual',
  attendance: 'Attendance',
};

/**
 * /admin/time — the manager's attendance hub (Batch 4E-1): an overview, attendance records,
 * exception review, correction review and timesheet review for the chosen organization, plus
 * attendance administration. Tabs and controls follow the user's permissions and the chosen
 * organization's capabilities; the API authorizes every record and action.
 */
export function TimeManagementPage() {
  const { authorization, authorizationLoading } = useAuth();
  const hasTimeOperations = [
    'time.view',
    'time.approve',
    'time.correct',
    'time.timesheet.approve',
    'time.timesheet.manage',
  ].some((key) => hasPermission(authorization, key));
  const canAdministerAttendance = ATTENDANCE_ADMIN_PERMISSIONS.some((key) =>
    hasPermission(authorization, key),
  );
  const hasAnyAccess = hasTimeOperations || canAdministerAttendance;

  // Batch 10C: loading and the denied state in the page's own (full) width — the page used to
  // load at 6xl and render at 7xl. Presentation only; the API authorizes every request.
  if (authorizationLoading || !hasAnyAccess)
    return (
      <PermissionGate
        loading={authorizationLoading}
        allowed={false}
        width="full"
        deniedMessage="You do not have permission to view time operations."
      >
        {null}
      </PermissionGate>
    );

  return (
    <TimeManagementContent
      hasTimeOperations={hasTimeOperations}
      canAdministerAttendance={canAdministerAttendance}
    />
  );
}

function RecordsTab({ organization }: { organization: ReviewOrganization }) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const searchId = useId();
  const canView = Boolean(
    organization.actions.canViewAttendance || organization.actions.canCorrectTime,
  );
  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementEntries({
        organizationId: organization.id,
        ...historyQuery(organization),
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(search ? { search } : {}),
        limit: 50,
        ...(afterId ? { afterId } : {}),
      }),
    [organization, startDate, endDate, search],
  );
  const list = usePagedList(canView ? fetchPage : null, 'Unable to load attendance records.');
  return (
    <ReviewPanel title="Attendance records">
      {!canView ? (
        <p className="text-sm text-slate-700">
          Attendance records are shown to people who can view attendance in this organization.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor={searchId} className="block text-sm font-medium text-slate-700">
                Employee or assignment
              </label>
              <input
                id={searchId}
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                className={inputClass}
              />
            </div>
            <DateField label="Start date" value={startDate} onChange={setStartDate} />
            <DateField label="End date" value={endDate} onChange={setEndDate} />
          </div>
          <div className="mt-4">
            {list.loading ? (
              <LoadingState label="Loading attendance records…" />
            ) : list.error ? (
              <ErrorState message={list.error} onRetry={() => void list.reload()} />
            ) : (
              <RecordsTable entries={list.items} label="Attendance records" showPayable />
            )}
            <LoadMore list={list} noun={['record', 'records']} />
          </div>
        </>
      )}
    </ReviewPanel>
  );
}

function TimeManagementContent({
  hasTimeOperations,
  canAdministerAttendance,
}: {
  hasTimeOperations: boolean;
  canAdministerAttendance: boolean;
}) {
  const { identity } = useAuth();
  const currentUserId = identity?.id ?? null;
  const tabs: Tab[] = [
    ...(hasTimeOperations
      ? (['overview', 'records', 'exceptions', 'corrections', 'timesheets', 'scheduled'] as const)
      : []),
    ...(canAdministerAttendance ? (['attendance'] as const) : []),
  ];
  // Deep links such as /admin/time#timesheets open that tab when it is available; picking a
  // tab writes it (Batch 10F, as the other administration pages), so a bookmark keeps it.
  const [tab, setTab] = useTabParam<Tab>(tabs, tabs[0] ?? 'overview', {
    writeHash: true,
  });
  const tabIdBase = useTabIdBase('time-operations');
  // Batch 4F (C10): opt in to the read-only history of organizations with attendance off.
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const review = useReviewOrganizations(hasTimeOperations, includeDisabled);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const search = useLocationSearch();
  const params = new URLSearchParams(search);
  const periodId = params.get('timesheetPeriod');
  const employeeId = params.get('timesheetEmployee');
  const selection = periodId && employeeId ? { periodId, employeeId } : null;

  function selectTab(next: Tab, attendanceTab?: string) {
    setTab(next);
    setNotice(null);
    setNoticeError(null);
    if (next !== 'attendance') setLocationSearchParam('attendanceTab', null);
    else if (attendanceTab) setLocationSearchParam('attendanceTab', attendanceTab);
  }

  function selectTimesheet(next: { periodId: string; employeeId: string } | null) {
    setLocationSearchParam('timesheetPeriod', next?.periodId ?? null);
    setLocationSearchParam('timesheetEmployee', next?.employeeId ?? null);
  }

  async function openTimesheet(
    organization: ReviewOrganization,
    employee: string,
    workDate: string,
  ) {
    setNotice(null);
    setNoticeError(null);
    try {
      const page = await timeApi.periods({
        organizationId: organization.id,
        ...historyQuery(organization),
        from: workDate,
        to: workDate,
        limit: 1,
      });
      const period = page.items[0];
      if (!period) {
        setNoticeError(`No time period covers ${formatDateOnly(workDate)} yet.`);
        return;
      }
      selectTimesheet({ periodId: period.id, employeeId: employee });
      setTab('timesheets');
    } catch (cause) {
      setNoticeError(timeErrorMessage(cause, 'Unable to find the timesheet.'));
    }
  }

  const organization = review.organization;
  const reviewContent = () => {
    if (review.error) {
      return (
        <ErrorState
          title="Time operations could not be loaded"
          message={review.error}
          onRetry={review.reload}
        />
      );
    }
    if (review.organizations === null) return <LoadingState label="Loading time operations…" />;
    if (!organization) {
      return (
        <EmptyState
          title="No organizations to review"
          description="You don’t review attendance in any organization with Time & attendance enabled."
        />
      );
    }
    const historical = isHistoricalOrganization(organization);
    switch (tab) {
      case 'overview':
        if (historical) {
          return (
            <EmptyState
              title="No live overview"
              description="Nothing is happening while attendance is turned off. Its history is in Records, Exceptions, Corrections and Timesheets."
            />
          );
        }
        return (
          <AttendanceOverview
            key={organization.id}
            organization={organization}
            onNavigate={(next, attendanceTab) => selectTab(next, attendanceTab)}
          />
        );
      case 'records':
        return <RecordsTab key={organization.id} organization={organization} />;
      case 'exceptions':
        return (
          <ExceptionReview
            key={organization.id}
            organization={organization}
            currentUserId={currentUserId}
            onChanged={setNotice}
            onOpenTimesheet={(employee, workDate) =>
              void openTimesheet(organization, employee, workDate)
            }
          />
        );
      case 'corrections':
        return (
          <CorrectionReview
            key={organization.id}
            organization={organization}
            currentUserId={currentUserId}
          />
        );
      case 'timesheets':
        return (
          <TimesheetReview
            key={organization.id}
            organization={organization}
            currentUserId={currentUserId}
            selection={selection}
            onSelect={selectTimesheet}
          />
        );
      case 'scheduled':
        if (historical) {
          return (
            <EmptyState
              title="Scheduled vs actual is not available"
              description="It needs Time & attendance turned on in this organization."
            />
          );
        }
        if (!organization.actions.canViewAttendance) {
          return (
            <EmptyState
              title="Scheduled vs actual is not available"
              description="It is shown to people who can view attendance and schedules in this organization."
            />
          );
        }
        return <ScheduledVsActual key={organization.id} organization={organization} />;
      default:
        return null;
    }
  };

  return (
    <PageContainer width="full">
      <PageHeader
        eyebrow="Admin"
        title="Time operations"
        description="Attendance, exceptions, corrections and timesheet approvals for the organizations you review."
      />
      <div className="mt-6 space-y-3">
        {tab !== 'attendance' && review.organizations && review.organizations.length > 0 && (
          <OrganizationPicker
            organizations={review.organizations}
            value={organization?.id ?? ''}
            onChange={(id) => {
              review.setOrganizationId(id);
              selectTimesheet(null);
            }}
          />
        )}
        <HistoricalToggle
          checked={includeDisabled}
          onChange={(checked) => {
            setIncludeDisabled(checked);
            selectTimesheet(null);
          }}
        />
        {tab !== 'attendance' && organization && isHistoricalOrganization(organization) && (
          <HistoricalNotice organizationName={organization.name} />
        )}
      </div>
      {/* Batch 10C: the shared TabList (tab roles, arrow keys, `#hash` deep links via
          useTabParam with writeHash); it used to be a row of toggle buttons. */}
      <div className="mt-5">
        <TabList
          tabs={tabs.map((item) => ({ id: item, label: TAB_LABELS[item] }))}
          active={tab}
          onChange={(next) => selectTab(next)}
          label="Time operations sections"
          idBase={tabIdBase}
        />
      </div>
      <div className="mt-4 space-y-3">
        {noticeError && <ErrorBanner>{noticeError}</ErrorBanner>}
        {notice && <FeedbackMessage>{notice}</FeedbackMessage>}
      </div>
      <TabPanel idBase={tabIdBase} id={tab}>
        {tab === 'attendance' ? (
          <AttendanceAdmin includeDisabled={includeDisabled} />
        ) : (
          reviewContent()
        )}
      </TabPanel>
    </PageContainer>
  );
}
