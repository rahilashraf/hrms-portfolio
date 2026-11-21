'use client';

import { useTabParam } from '../../lib/navigation/use-location-hash';
import { useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageHeader, ErrorBanner } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import type { LeaveOrganization } from '../../lib/leave/types';
import { LeaveBalancesPanel } from './leave-balances-panel';
import { PolicyResolverPanel } from './leave-admin-sections';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { HolidaysPanel, LeavePoliciesPanel, LeaveTypesPanel } from './leave-config-panels';
import { inputClass } from './leave-shared';
import { CalendarPanel } from './leave-calendar-panel';
import { RequestsPanel } from './leave-requests-panel';
import { PageContainer } from '../ui/page-container';

type Tab = 'requests' | 'calendar' | 'balances' | 'holidays' | 'types' | 'policies';

const TAB_LABELS: Record<Tab, string> = {
  requests: 'Requests',
  calendar: 'Calendar',
  balances: 'Balances',
  holidays: 'Holidays',
  types: 'Leave types',
  policies: 'Policies',
};

export function LeaveManagementPage() {
  const [organizations, setOrganizations] = useState<LeaveOrganization[] | null>(null);
  const [organizationId, setOrganizationId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    leaveApi
      .organizations()
      .then((result) => {
        if (!active) return;
        setOrganizations(result.items);
        setOrganizationId(result.items[0]?.id ?? '');
      })
      .catch((cause) => {
        if (!active) return;
        setOrganizations([]);
        setError(leaveErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  if (organizations === null) {
    return (
      <PageContainer width="full">
        <p role="status" className="text-sm text-slate-600">
          Loading leave operations…
        </p>
      </PageContainer>
    );
  }
  if (error) {
    return (
      <PageContainer width="full">
        <ErrorBanner>{error}</ErrorBanner>
      </PageContainer>
    );
  }
  const organization = organizations.find((o) => o.id === organizationId);
  if (!organization)
    return (
      <PageContainer width="full" padded={false}>
        <Forbidden message="You do not have permission to manage leave." />
      </PageContainer>
    );

  return (
    <PageContainer width="full">
      <PageHeader
        eyebrow="Admin"
        title="Leave operations"
        description="Scoped leave requests, coverage, balances, the holiday calendar and leave configuration."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-700">
            Organization
            <select
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
              className={inputClass}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      {/* Keyed by organization so every tab reloads from scratch on a switch. */}
      <OrganizationLeave key={organization.id} organization={organization} />
    </PageContainer>
  );
}

function OrganizationLeave({ organization }: { organization: LeaveOrganization }) {
  const { actions } = organization;
  const tabs = (Object.keys(TAB_LABELS) as Tab[]).filter((tab) => {
    switch (tab) {
      case 'requests':
      case 'calendar':
        return actions.canReadRequests;
      case 'balances':
        return actions.canViewBalances;
      case 'holidays':
        return actions.canReadHolidays;
      case 'types':
      case 'policies':
        return actions.canReadConfiguration;
    }
  });
  // Deep links such as /admin/leave#holidays open that tab when it is available.
  const [tab, setTab] = useTabParam<Tab>(tabs, tabs[0] ?? 'requests', {
    writeHash: true,
  });
  const idBase = useTabIdBase('leave');

  return (
    <>
      {!organization.timezone && (
        <div className="mt-6">
          <ErrorBanner>
            This organization has no timezone. Leave can only be requested on positions whose work
            location has one.
          </ErrorBanner>
        </div>
      )}
      {/* Batch 6B (L7): the shared accessible tabs (roles, roving focus, arrow keys). */}
      <div className="mt-6">
        <TabList
          tabs={tabs.map((id) => ({ id, label: TAB_LABELS[id] }))}
          active={tab}
          onChange={setTab}
          label="Leave sections"
          idBase={idBase}
          withPanels
        />
        <TabPanel idBase={idBase} id={tab}>
          {tab === 'requests' && <RequestsPanel organization={organization} />}
          {tab === 'calendar' && <CalendarPanel organization={organization} />}
          {tab === 'balances' && <LeaveBalancesPanel organization={organization} />}
          {tab === 'holidays' && <HolidaysPanel organization={organization} />}
          {tab === 'types' && <LeaveTypesPanel organization={organization} />}
          {tab === 'policies' && (
            <div className="space-y-6">
              <PolicyResolverPanel organization={organization} />
              <LeavePoliciesPanel organization={organization} />
            </div>
          )}
        </TabPanel>
      </div>
    </>
  );
}
