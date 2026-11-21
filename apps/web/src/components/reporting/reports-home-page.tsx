'use client';

import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageHeader, ErrorBanner } from '../organization/shared';
import { reportingApi } from '../../lib/reporting/api';
import { reportingErrorMessage } from '../../lib/reporting/errors';
import { AREA_LABELS, MIN_GROUP_SIZE } from '../../lib/reporting/format';
import type { ReportCatalog, ReportOrganization } from '../../lib/reporting/types';
import { useAuth } from '../../providers/auth-provider';
import {
  Badge,
  canSeeReports,
  EmptyState,
  inputClass,
  Loading,
  organizationFromLocation,
  reportHref,
} from './reporting-shared';

/**
 * Reporting home (/reports): pick an organization, then the report areas the caller can run
 * there (from the catalog — areas without a runnable report are not listed). Needs report.read.
 */
export function ReportsHomePage() {
  const { authorization, authorizationLoading } = useAuth();
  if (authorizationLoading) {
    return (
      <PageContainer width="wide">
        <Loading />
      </PageContainer>
    );
  }
  if (!canSeeReports(authorization)) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to view reports." />
      </PageContainer>
    );
  }
  return <ReportsHome />;
}

function ReportsHome() {
  const [organizations, setOrganizations] = useState<ReportOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const preferred = organizationFromLocation();
      reportingApi
        .organizations()
        .then(({ items }) => {
          setOrganizations(items);
          setOrganizationId(
            items.some((o) => o.id === preferred) ? preferred : (items[0]?.id ?? ''),
          );
        })
        .catch((cause) => setError(reportingErrorMessage(cause, 'Unable to load organizations.')))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const organization = organizations.find((o) => o.id === organizationId);

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Reports"
        title="Reports"
        description="Aggregate reports computed from current HR data. You only see the reports, and the parts of the organization, your access covers."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="reports-organization">
            Organization
            <select
              id="reports-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setOrganizationId(next);
                window.history.replaceState(window.history.state, '', reportHref(null, next));
              }}
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
      <div className="mt-6 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {loading ? (
          <Loading>Loading organizations…</Loading>
        ) : !organization ? (
          !error && <EmptyState>No organizations are within your reporting access.</EmptyState>
        ) : (
          <Catalog key={organization.id} organization={organization} />
        )}
      </div>
    </PageContainer>
  );
}

function Catalog({ organization }: { organization: ReportOrganization }) {
  const [catalog, setCatalog] = useState<ReportCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      reportingApi
        .catalog(organization.id)
        .then((result) => {
          if (active) setCatalog(result);
        })
        .catch((cause) => {
          if (active) setError(reportingErrorMessage(cause, 'Unable to load the report catalog.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organization.id]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!catalog) return <Loading>Loading reports…</Loading>;
  const areas = catalog.items.filter((area) => area.reports.length > 0);
  if (areas.length === 0) {
    return (
      <EmptyState>
        No reports are available to you in {organization.name}. Reports need report access together
        with access to the underlying data.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6">
      {areas.map((area) => (
        <section
          key={area.area}
          aria-labelledby={`area-${area.area}`}
          className="rounded-xl border border-slate-200 bg-white p-5"
        >
          <h2 id={`area-${area.area}`} className="text-lg font-semibold text-slate-950">
            {AREA_LABELS[area.area] ?? area.area}
          </h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {area.reports.map((report) => (
              <li
                key={report.key}
                className="flex flex-col rounded-lg border border-slate-200 p-4 hover:border-indigo-300"
              >
                <Link
                  href={reportHref(report.key, organization.id)}
                  className="font-medium text-indigo-700 hover:underline"
                >
                  {report.title}
                </Link>
                <p className="mt-1 flex-1 text-sm text-slate-600">{report.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {report.sensitive && (
                    <Badge
                      tone="amber"
                      title={`Groups with fewer than ${MIN_GROUP_SIZE} people are suppressed.`}
                    >
                      Small groups suppressed
                    </Badge>
                  )}
                  {report.excludesSelf && <Badge>Excludes your own records</Badge>}
                  {report.canExport && <Badge tone="emerald">Exportable</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
