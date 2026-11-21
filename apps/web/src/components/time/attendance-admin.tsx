'use client';

import { useEffect, useState } from 'react';
import { attendanceApi } from '../../lib/attendance/api';
import type { AttendanceOrganization, TimePolicy } from '../../lib/attendance/types';
import { timeErrorMessage } from '../../lib/time/errors';
import { label } from '../../lib/time/format';
import { setLocationSearchParam } from '../../lib/navigation/use-location-hash';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { inputClass } from '../ui/tokens';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { ErrorState } from '../ui/states';
import { AssignmentAttendancePanel } from './admin/assignment-attendance';
import { EffectivePolicyPanel } from './admin/effective-policy';
import { PoliciesPanel } from './admin/policies-panel';
import {
  HistoricalNotice,
  isHistoricalOrganization,
  organizationLabel,
} from './review/review-shared';
import { ExpectedSignInsPanel } from './admin/expected-sign-ins-panel';
import { KiosksPanel } from './admin/kiosks-panel';
import { SignInsPanel } from './admin/sign-ins-panel';
export { localDateTimeIn } from './admin/attendance-shared';

type AttendanceTab = 'sign-ins' | 'expected' | 'kiosks' | 'policies' | 'effective' | 'assignments';

/**
 * Phase 9.5 — attendance administration in Time operations: sign-ins of SIGN_IN_ONLY work,
 * expected sign-ins against published shifts, trusted kiosks, and attendance policy layers.
 * The organization list (and what may be done in each) comes from the user's Time grants;
 * the server checks every action again on its own scope.
 */
export function AttendanceAdmin({ includeDisabled = false }: { includeDisabled?: boolean } = {}) {
  const [organizations, setOrganizations] = useState<AttendanceOrganization[] | null>(null);
  const [organizationId, setOrganizationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    attendanceApi
      .organizations(includeDisabled ? { includeDisabledOrganizations: true } : {})
      .then((result) => {
        if (!active) return;
        // Batch 4E-1: the list also carries organizations the user only reviews in; attendance
        // administration offers just the ones it has something to show for.
        const administered = result.items.filter(
          ({ actions }) =>
            actions.canViewSignIns ||
            actions.canCorrectSignIns ||
            actions.canManageDevices ||
            actions.canManagePolicies ||
            actions.canManagePins,
        );
        setError(null);
        setOrganizations(administered);
        setOrganizationId((current) =>
          administered.some((item) => item.id === current) ? current : administered[0]?.id || '',
        );
      })
      .catch((cause) => {
        if (active) {
          setOrganizations([]);
          setError(timeErrorMessage(cause, 'Unable to load attendance organizations.'));
        }
      });
    return () => {
      active = false;
    };
  }, [attempt, includeDisabled]);

  if (organizations === null) {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading attendance administration…
      </p>
    );
  }
  if (error) {
    return (
      <ErrorState
        title="Attendance administration could not be loaded"
        message={error}
        onRetry={() => {
          setError(null);
          setOrganizations(null);
          setAttempt((value) => value + 1);
        }}
      />
    );
  }
  const organization = organizations.find((o) => o.id === organizationId);
  if (!organization) {
    return (
      <p className="text-sm text-slate-600">
        You do not administer attendance in any organization.
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {organizations.length > 1 && (
        <label className="block max-w-sm text-sm font-medium text-slate-700">
          Organization
          <select
            value={organizationId}
            onChange={(event) => {
              setOrganizationId(event.target.value);
              // Batch 10C: the sub-tab belongs to the organization left behind (the next one
              // may not offer it); the new organization opens on its first sub-tab.
              setLocationSearchParam('attendanceTab', null);
            }}
            className={inputClass}
          >
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {organizationLabel(o)}
              </option>
            ))}
          </select>
        </label>
      )}
      {organizations.length === 1 && isHistoricalOrganization(organization) && (
        <p className="text-sm text-slate-600">
          Organization:{' '}
          <span className="font-semibold text-slate-900">{organizationLabel(organization)}</span>
        </p>
      )}
      {isHistoricalOrganization(organization) && (
        <HistoricalNotice organizationName={organization.name} />
      )}
      {/* Keyed by organization so every panel reloads from scratch on a switch. */}
      <OrganizationAttendance key={organization.id} organization={organization} />
    </div>
  );
}

function OrganizationAttendance({ organization }: { organization: AttendanceOrganization }) {
  const { actions } = organization;
  // Batch 4F (C10): attendance turned off: only the sign-in history is readable (read only).
  const historical = isHistoricalOrganization(organization);
  const tabs: Array<{ key: AttendanceTab; title: string }> = historical
    ? actions.canViewSignIns
      ? [{ key: 'sign-ins' as const, title: 'Sign-ins' }]
      : []
    : [
        ...(actions.canViewSignIns
          ? [
              { key: 'sign-ins' as const, title: 'Sign-ins' },
              { key: 'expected' as const, title: 'Expected sign-ins' },
            ]
          : []),
        ...(actions.canManageDevices ? [{ key: 'kiosks' as const, title: 'Kiosks' }] : []),
        ...(actions.canManagePolicies
          ? [{ key: 'policies' as const, title: 'Attendance policies' }]
          : []),
        // Batch 4E-2: the effective policy and how assignments record attendance (B1, B4).
        ...(actions.canManagePolicies || actions.canViewSignIns
          ? [
              { key: 'effective' as const, title: 'Effective policy' },
              { key: 'assignments' as const, title: 'Assignment attendance' },
            ]
          : []),
      ];
  const [inspect, setInspect] = useState<{ assignmentId: string; date: string } | null>(null);
  // Batch 10C: the shared useTabParam in query mode — `?attendanceTab=kiosks` (the sidebar's links)
  // opens that sub-tab, picking one writes it into the URL (removed for the first tab; the hash
  // and other parameters are kept), Back/Forward follow the URL.
  const [selectedTab, selectTab] = useTabParam<AttendanceTab>(
    tabs.map((item) => item.key),
    tabs[0]?.key ?? 'sign-ins',
    { mode: 'query', param: 'attendanceTab' },
  );
  const tabIdBase = useTabIdBase('attendance');

  if (tabs.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        {historical
          ? 'There is nothing to show for this organization while attendance is turned off.'
          : "Attendance PINs are managed from each employee's profile."}
      </p>
    );
  }
  return (
    <div className="space-y-5">
      <TabList
        tabs={tabs.map((item) => ({ id: item.key, label: item.title }))}
        active={selectedTab}
        onChange={selectTab}
        label="Attendance"
        idBase={tabIdBase}
      />
      <TabPanel idBase={tabIdBase} id={selectedTab}>
        {selectedTab === 'sign-ins' && <SignInsPanel organization={organization} />}
        {selectedTab === 'expected' && <ExpectedSignInsPanel organization={organization} />}
        {selectedTab === 'kiosks' && <KiosksPanel organization={organization} />}
        {selectedTab === 'policies' && (
          <PoliciesPanel organization={organization} onInspect={() => selectTab('effective')} />
        )}
        {selectedTab === 'effective' && (
          <EffectivePolicyPanel
            key={inspect ? `${inspect.assignmentId}-${inspect.date}` : 'none'}
            organization={organization}
            assignmentId={inspect?.assignmentId}
            date={inspect?.date}
          />
        )}
        {selectedTab === 'assignments' && (
          <AssignmentAttendancePanel
            onInspect={(assignmentId, date) => {
              setInspect({ assignmentId, date });
              selectTab('effective');
            }}
          />
        )}
      </TabPanel>
    </div>
  );
}

// ─── Policies ────────────────────────────────────────────────────────────────

export function attendanceSummary(policy: TimePolicy): string {
  const attendance = policy.config.attendance;
  const clock = policy.config.clock;
  const parts = [
    ...(clock && typeof clock.mode === 'string'
      ? [clock.mode === 'LIVE_CLOCK' ? 'Clocking on' : 'Clocking off']
      : []),
    ...(attendance
      ? (['trackingMode', 'captureMode', 'kioskLocationRule'] as const)
          .filter((key) => typeof attendance[key] === 'string')
          .map((key) => label(String(attendance[key])))
      : []),
  ];
  return parts.join(' · ') || 'No attendance settings';
}

/** The `clock` and `breaks` sections of a new layer; blank selections are inherited. */
export function clockSections(
  text: (key: string) => string,
): Record<string, Record<string, unknown>> {
  const clock: Record<string, unknown> = {};
  if (text('clockMode')) clock.mode = text('clockMode');
  if (text('assignmentSwitching'))
    clock.assignmentSwitching = text('assignmentSwitching') === 'true';
  const breaks: Record<string, unknown> = {};
  if (text('breaksMode')) breaks.mode = text('breaksMode');
  return {
    ...(Object.keys(clock).length > 0 ? { clock } : {}),
    ...(Object.keys(breaks).length > 0 ? { breaks } : {}),
  };
}
