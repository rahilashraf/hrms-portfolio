'use client';

import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { dashboardApi, type Dashboard, type DashboardSelf } from '../../lib/dashboard/api';
import { formatMinutes } from '../../lib/leave/format';
import { flattenNavigation, visibleNavigation } from '../../lib/navigation/registry';
import { accountStatusLabel } from '../../lib/ui/labels';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalWorkspace } from '../../providers/workspace-provider';
import { SetupChecklist, canSeeSetup } from '../setup/setup-checklist';
import { buttonClass } from '../ui/button';
import { PageHeader } from '../ui/page-header';
import { EmptyState, ErrorState, Skeleton } from '../ui/states';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; dashboard: Dashboard }
  | { status: 'error' };

/**
 * Phase 20 — the dashboard for the selected organization (GET /dashboard). Every card, count
 * and quick action comes from the API, which returns only what the caller is authorized for
 * in enabled modules; nothing is invented here.
 */
export function DashboardPage() {
  const { identity } = useAuth();
  const context = useOptionalWorkspace();
  const organization = context?.selectedOrganization ?? null;
  const organizationId = organization?.id ?? null;
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setState({ status: 'loading' });
      dashboardApi
        .get(organizationId)
        .then((dashboard) => {
          if (active) setState({ status: 'ready', dashboard });
        })
        .catch(() => {
          if (active) setState({ status: 'error' });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, attempt]);

  const navContext = context?.navContext ?? null;
  const navLeaves = useMemo(
    () => (navContext ? flattenNavigation(visibleNavigation(navContext)) : []),
    [navContext],
  );
  const showsMyTime = navLeaves.some((item) => item.id === 'my-time');

  if (!identity) return null;
  const firstName = context?.workspace?.user.displayName?.split(' ')[0];
  const showSetup = Boolean(
    organization && context?.navContext && canSeeSetup(context.navContext.permissions),
  );
  const loading =
    Boolean(organizationId) && (state.status === 'idle' || state.status === 'loading');
  const dashboard = state.status === 'ready' ? state.dashboard : null;

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow={organization ? organization.name : 'Account overview'}
        title={firstName ? `Welcome, ${firstName}` : 'Welcome'}
        description="What needs your attention today."
      />

      <div className="mt-8 space-y-8">
        {loading ? (
          <DashboardSkeleton />
        ) : state.status === 'error' ? (
          <ErrorState
            title="Dashboard unavailable"
            message="Your dashboard could not be loaded. Your pages are still available from the navigation."
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : dashboard ? (
          <DashboardContent dashboard={dashboard} showsMyTime={showsMyTime} />
        ) : null}

        {showSetup && organization && (
          <SetupChecklist
            variant="card"
            organizationId={organization.id}
            userId={context?.workspace?.user.id ?? identity.id}
          />
        )}

        <section
          aria-labelledby="account-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 id="account-heading" className="text-lg font-semibold text-slate-950">
            Account
          </h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-slate-500">Email</dt>
              <dd className="mt-1 break-all font-medium text-slate-900">{identity.email}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Account status</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {accountStatusLabel(identity.status)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Email verification</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {identity.emailVerifiedAt ? 'Verified' : 'Not verified'}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </PageContainer>
  );
}

function DashboardContent({
  dashboard,
  showsMyTime,
}: {
  dashboard: Dashboard;
  showsMyTime: boolean;
}) {
  const { cards, self, quickActions } = dashboard;
  if (cards.length === 0 && !self && quickActions.length === 0) {
    return (
      <EmptyState
        title="Nothing needs your attention"
        description="There are no items for you in this organization right now."
        icon="check"
      />
    );
  }
  return (
    <>
      {quickActions.length > 0 && (
        <section aria-labelledby="quick-actions-heading">
          <h2 id="quick-actions-heading" className="text-lg font-semibold text-slate-950">
            Quick actions
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {quickActions.map((action) => (
              <li key={action.key}>
                <Link href={action.href} className={buttonClass('secondary')}>
                  {action.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {self && <SelfService self={self} showsMyTime={showsMyTime} />}
      {cards.length > 0 && (
        <section aria-labelledby="overview-heading">
          <h2 id="overview-heading" className="text-lg font-semibold text-slate-950">
            Overview
          </h2>
          <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((card) => (
              <li key={card.key} data-card={card.key}>
                <Link
                  href={card.href}
                  className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {card.area && (
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {card.area}
                    </span>
                  )}
                  <span className="mt-2 text-3xl font-semibold text-slate-950">
                    {card.value.toLocaleString()}
                  </span>
                  <span className="mt-1 text-sm text-slate-700">{card.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  href,
  linkLabel,
}: {
  label: string;
  value: number;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-950">{value.toLocaleString()}</p>
      {href && linkLabel && (
        <Link
          href={href}
          className="mt-2 inline-block text-sm font-medium text-[var(--hrms-accent-text)] hover:underline"
        >
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

function SelfService({ self, showsMyTime }: { self: DashboardSelf; showsMyTime: boolean }) {
  return (
    <section aria-labelledby="self-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="self-heading" className="text-lg font-semibold text-slate-950">
          My work
        </h2>
        {showsMyTime && (
          <Link href="/time" className={buttonClass('primary')}>
            Go to My Time
          </Link>
        )}
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {self.todayShifts !== null && <Stat label="Today's shifts" value={self.todayShifts} />}
        {self.policyAcknowledgementsDue !== null && (
          <Stat
            label="Policies to acknowledge"
            value={self.policyAcknowledgementsDue}
            href="/documents"
            linkLabel="Open My Documents"
          />
        )}
        {self.selfReviewsDue !== null && (
          <Stat
            label="Self-reviews due"
            value={self.selfReviewsDue}
            href="/performance"
            linkLabel="Open My Performance"
          />
        )}
        {self.reviewsToWrite !== null && (
          <Stat
            label="Reviews to write"
            value={self.reviewsToWrite}
            href="/performance"
            linkLabel="Open My Performance"
          />
        )}
        {self.openGoals !== null && (
          <Stat
            label="Open goals"
            value={self.openGoals}
            href="/performance"
            linkLabel="Open My Performance"
          />
        )}
      </div>
      {self.leaveBalances !== null && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium text-slate-900">Leave balance</h3>
            <Link
              href="/leave"
              className="text-sm font-medium text-[var(--hrms-accent-text)] hover:underline"
            >
              Open My Leave
            </Link>
          </div>
          {self.leaveBalances.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No tracked leave balances.</p>
          ) : (
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {self.leaveBalances.map((balance) => (
                <li key={balance.leaveTypeId} className="rounded-lg bg-slate-50 p-3">
                  <p className="text-sm text-slate-600">{balance.name}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-950">
                    {formatMinutes(balance.availableMinutes)}
                    <span className="ml-1 text-sm font-normal text-slate-600">available</span>
                  </p>
                  {balance.pendingMinutes > 0 && (
                    <p className="text-xs text-slate-500">
                      {formatMinutes(balance.pendingMinutes)} pending
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading your dashboard…
      </p>
      <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
