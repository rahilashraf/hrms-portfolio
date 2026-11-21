'use client';

import { PageContainer } from '../ui/page-container';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PageHeader } from '../organization/shared';
import { benefitsApi } from '../../lib/benefits/api';
import { benefitsErrorMessage, benefitsFailureKind } from '../../lib/benefits/errors';
import type { BenefitsFailureKind } from '../../lib/benefits/errors';
import type { Dependent, Election, MyEligibility } from '../../lib/benefits/types';
import { ErrorState } from '../ui/states';
import {
  costText,
  coveragePeriod,
  ElectionStatusBadge,
  EmptyState,
  formatDateOnly,
  label,
} from './benefits-shared';
import { DataTable } from '../ui/data-table';

type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'failed'; kind: BenefitsFailureKind; message: string };

/** One self-service read, loaded on its own with a retry (Batch 7C: no all-or-nothing page). */
function useLoad<T>(load: () => Promise<T>, fallback: string) {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load()
        .then((value) => active && setResult({ state: 'ready', value }))
        .catch((cause: unknown) => {
          if (!active) return;
          setResult({
            state: 'failed',
            kind: benefitsFailureKind(cause),
            message: benefitsErrorMessage(cause, fallback),
          });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, fallback, attempt]);
  const retry = useCallback(() => {
    setResult({ state: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return [result, retry] as const;
}

const loadMine = () => benefitsApi.mine();
const loadDependents = () => benefitsApi.myDependents();
const loadEligibility = () => benefitsApi.myEligibility();

/**
 * Employee self-service "My Benefits": read-only. HR records every election; employees see
 * their coverage, costs, covered dependents and the plans they are offered. Each part loads on
 * its own; a missing employee record, Benefits being switched off and a refusal are told apart.
 */
export function MyBenefitsPage() {
  const [mine, retryMine] = useLoad(loadMine, 'Unable to load your benefits.');
  const [dependents, retryDependents] = useLoad(loadDependents, 'Unable to load your dependents.');
  const [eligibility, retryEligibility] = useLoad(
    loadEligibility,
    'Unable to load the plans you are eligible for.',
  );

  // A missing employee record or a disabled module concerns the whole page.
  const pageFailure =
    mine.state === 'failed' && (mine.kind === 'NOT_EMPLOYEE' || mine.kind === 'MODULE_DISABLED')
      ? mine.kind
      : null;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My benefits"
        description="Your benefit coverage, costs and covered dependents. Contact HR to enroll, change or waive coverage."
      />
      <div className="mt-8 space-y-6">
        {pageFailure === 'NOT_EMPLOYEE' ? (
          <EmptyState>
            Your account is not linked to an employee record, so there are no benefits to show.
          </EmptyState>
        ) : pageFailure === 'MODULE_DISABLED' ? (
          <EmptyState>Benefits is turned off for your organization.</EmptyState>
        ) : (
          <>
            <Part
              id="current-benefits"
              title="Current and upcoming"
              result={mine}
              onRetry={retryMine}
            >
              {(value) => {
                const current = value.items.filter(
                  (e) => e.status !== 'ENDED' && e.status !== 'SUPERSEDED',
                );
                return current.length === 0 ? (
                  <EmptyState>You have no current benefit coverage.</EmptyState>
                ) : (
                  <ElectionTable items={current} label="Current and upcoming coverage" />
                );
              }}
            </Part>
            {eligibility.state === 'failed' ? (
              <Part
                id="offered-benefits"
                title="Plans you are eligible for"
                result={eligibility}
                onRetry={retryEligibility}
              >
                {() => null}
              </Part>
            ) : eligibility.state === 'ready' && mine.state === 'ready' ? (
              <Offered eligibility={eligibility.value} elections={mine.value.items} />
            ) : null}
            <Part
              id="my-dependents"
              title="Dependents"
              result={dependents}
              onRetry={retryDependents}
            >
              {(value) => <DependentsTable items={value.items} />}
            </Part>
            {mine.state === 'ready' && mine.value.items.some((e) => e.status === 'ENDED') && (
              <section aria-labelledby="past-benefits" className="space-y-3">
                <h2 id="past-benefits" className="text-lg font-semibold text-slate-900">
                  Past coverage
                </h2>
                <ElectionTable
                  items={mine.value.items.filter((e) => e.status === 'ENDED')}
                  label="Past elections"
                />
              </section>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

function Part<T>({
  id,
  title,
  result,
  onRetry,
  children,
}: {
  id: string;
  title: string;
  result: Loaded<T>;
  onRetry(): void;
  children(value: T): ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold text-slate-900">
        {title}
      </h2>
      {result.state === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading…
        </p>
      ) : result.state === 'failed' ? (
        <ErrorState
          title={result.kind === 'FORBIDDEN' ? 'Not available to you' : 'Could not be loaded'}
          message={result.message}
          onRetry={result.kind === 'FORBIDDEN' ? undefined : onRetry}
        />
      ) : (
        children(result.value)
      )}
    </section>
  );
}

/** Plans the employee is eligible for and has no current or upcoming election of. */
function Offered({
  eligibility,
  elections,
}: {
  eligibility: MyEligibility;
  elections: Election[];
}) {
  // Batch 7C: an ended (or rescinded) election never hides a plan offered again.
  const electedPlanIds = new Set(
    elections
      .filter((e) => e.status !== 'ENDED' && e.status !== 'SUPERSEDED')
      .map((e) => e.plan.id),
  );
  const offered = eligibility.items.flatMap((item) =>
    item.plans
      .filter((plan) => plan.eligibility.eligible && !electedPlanIds.has(plan.planId))
      .map((plan) => ({ ...plan, positionName: item.positionName })),
  );
  if (offered.length === 0) return null;
  return (
    <section aria-labelledby="offered-benefits" className="space-y-3">
      <h2 id="offered-benefits" className="text-lg font-semibold text-slate-900">
        Plans you are eligible for
      </h2>
      <DataTable
        label="Eligible plans"
        rows={offered}
        rowKey={(plan) => `${plan.planId}-${plan.positionName}`}
        columns={[
          {
            key: 'plan',
            header: 'Plan',
            rowHeader: true,
            cell: (plan) => <>{plan.name}</>,
          },
          {
            key: 'type',
            header: 'Type',
            cell: (plan) => <>{label(plan.benefitType)}</>,
          },
          {
            key: 'through',
            header: 'Through',
            cell: (plan) => <>{plan.positionName}</>,
          },
          {
            key: 'options',
            header: 'Options',
            cell: (plan) => <>{plan.options.map((option) => option.name).join(', ')}</>,
          },
        ]}
      />
    </section>
  );
}

function DependentsTable({ items }: { items: Dependent[] }) {
  if (items.length === 0) return <EmptyState>No dependents are recorded.</EmptyState>;
  return (
    <DataTable
      label="Your dependents"
      rows={items}
      rowKey={(dependent) => dependent.id}
      columns={[
        {
          key: 'name',
          header: 'Name',
          rowHeader: true,
          cell: (dependent) => (
            <>
              {dependent.firstName} {dependent.lastName}
            </>
          ),
        },
        {
          key: 'relationship',
          header: 'Relationship',
          cell: (dependent) => <>{label(dependent.relationship)}</>,
        },
        {
          key: 'birth',
          header: 'Date of birth',
          cell: (dependent) => <>{formatDateOnly(dependent.dateOfBirth)}</>,
        },
      ]}
    />
  );
}

function ElectionTable({ items, label: name }: { items: Election[]; label: string }) {
  return (
    <DataTable
      label={name}
      minWidth="min-w-[760px]"
      rows={items}
      rowKey={(item) => item.id}
      columns={[
        {
          key: 'plan',
          header: 'Plan',
          rowHeader: true,
          cell: (item) => (
            <>
              {item.plan.name}
              {item.plan.providerName && (
                <span className="block text-xs font-normal text-slate-500">
                  {item.plan.providerName}
                </span>
              )}
            </>
          ),
        },
        {
          key: 'coverage',
          header: 'Coverage',
          cell: (item) => <>{item.option?.name ?? 'Waived'}</>,
        },
        {
          key: 'status',
          header: 'Status',
          cell: (item) => (
            <>
              <ElectionStatusBadge status={item.status} />
            </>
          ),
        },
        {
          key: 'period',
          header: 'Period',
          cell: (item) => <>{coveragePeriod(item.coverageStart, item.coverageEnd)}</>,
        },
        {
          key: 'cost',
          header: 'Your cost',
          cell: (item) => <>{costText(item.cost)}</>,
        },
        {
          key: 'dependents',
          header: 'Covered dependents',
          cell: (item) => (
            <>
              {item.dependents.length === 0
                ? '—'
                : item.dependents.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}
            </>
          ),
        },
      ]}
    />
  );
}
