'use client';

import { DataTable } from '../ui/data-table';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader, ErrorBanner } from '../organization/shared';
import { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll/payroll-shared';
import { Field } from '../recruitment/recruitment-shared';
import { ACCOUNT_SECURITY_ACTIONS, auditActionLabel } from '../../lib/audit/account-actions';
import { auditApi } from '../../lib/audit/api';
import {
  AUDIT_ENTITY_TYPES,
  auditActorSource,
  auditEntityTypeLabel,
} from '../../lib/audit/entity-types';
import { auditErrorMessage } from '../../lib/audit/errors';
import {
  auditFilterQuery,
  auditMetadataText,
  auditOrganizationOptions,
  EMPTY_AUDIT_FILTERS,
  type AuditFilterForm,
} from '../../lib/audit/filters';
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_READ_PERMISSION,
  type AuditEntry,
  type AuditOrganizationOption,
  type AuditQuery,
} from '../../lib/audit/types';
import type { GrantSnapshot } from '../../lib/authorization/types';
import type { PickerOption } from '../../lib/pickers/sources';
import { RecordCombobox } from '../ui/record-combobox';
import { organizationApi } from '../../lib/organization/api';
import { useAuth } from '../../providers/auth-provider';
import { LoadingText } from '../ui/states';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';

/** "Oct 6, 2026, 9:30:15 AM" in the viewer's time zone. */
export function auditTimeText(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(
    date,
  );
}

/**
 * Audit log (/admin/audit): the read-only audit trail of one organization, newest first. Needs
 * audit.read at organization scope; the API returns identifiers, codes and a whitelisted subset
 * of the metadata only, and everything is rendered as plain text.
 */
export function AuditLogPage() {
  const { authorization } = useAuth();
  // Batch 10B: the shared gate (loading and denied in the page's own width).
  return (
    <RequirePermission
      anyOf={[AUDIT_READ_PERMISSION]}
      width="wide"
      deniedMessage="You do not have permission to read the audit log."
    >
      <AuditLog authorization={authorization} />
    </RequirePermission>
  );
}

const Loading = LoadingText;

/** The record-type choice that reveals a free-text code (for a type not in the list). */
const OTHER_ENTITY_TYPE = '__other__';

interface Results {
  query: AuditQuery;
  items: AuditEntry[];
  nextCursor: string | null;
  range: { from: string; to: string };
}

function AuditLog({ authorization }: { authorization: GrantSnapshot | null }) {
  const [organizations, setOrganizations] = useState<AuditOrganizationOption[] | null>(null);
  const [organizationId, setOrganizationId] = useState('');
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_AUDIT_FILTERS);
  const [query, setQuery] = useState<AuditQuery | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // How the chosen actor is shown (the filter itself keeps only the user id).
  const [actorOption, setActorOption] = useState<PickerOption | null>(null);
  // Batch R3.3: the actor suggestions cover the people who acted in the searched window.
  const searchedFrom = query?.from;
  const searchedTo = query?.to;
  const actorSource = useMemo(
    () =>
      auditActorSource(organizationId, {
        ...(searchedFrom ? { from: searchedFrom } : {}),
        ...(searchedTo ? { to: searchedTo } : {}),
      }),
    [organizationId, searchedFrom, searchedTo],
  );
  const entityTypeChoice = !form.entityType
    ? ''
    : (AUDIT_ENTITY_TYPES as readonly string[]).includes(form.entityType)
      ? form.entityType
      : OTHER_ENTITY_TYPE;
  const [otherEntityType, setOtherEntityType] = useState(false);

  // Organization names come from the organizations list when the user may read it; otherwise
  // the organizations of the audit.read grants are shown by id.
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      organizationApi
        .listOrganizations()
        .catch(() => [])
        .then((list) => {
          if (!active) return;
          const options = auditOrganizationOptions(authorization, list);
          setOrganizations(options);
          // A deep link (e.g. from a schedule's revision history) pre-filters one record.
          const linked = linkedAuditFilters(window.location.search);
          const first =
            (linked.organizationId &&
              options.find((option) => option.id === linked.organizationId)?.id) ||
            options[0]?.id ||
            '';
          setOrganizationId((current) => current || first);
          if (linked.entityType || linked.entityId) {
            setForm((current) => ({
              ...current,
              entityType: linked.entityType,
              entityId: linked.entityId,
            }));
          }
          if (first) {
            setQuery(
              (current) =>
                current ?? {
                  organizationId: first,
                  ...(linked.entityType ? { entityType: linked.entityType } : {}),
                  ...(linked.entityId ? { entityId: linked.entityId } : {}),
                },
            );
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [authorization]);

  useEffect(() => {
    if (!query) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      auditApi
        .list({ ...query, limit: AUDIT_DEFAULT_LIMIT })
        .then((page) => {
          if (active) setResults({ query, ...page });
        })
        .catch((cause) => {
          if (!active) return;
          setResults(null);
          setError(auditErrorMessage(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  function search(nextOrganizationId = organizationId, nextForm = form) {
    if (!nextOrganizationId) return;
    const result = auditFilterQuery(nextForm);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    setQuery({ organizationId: nextOrganizationId, ...result.query });
  }

  async function loadMore() {
    if (!results?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await auditApi.list({
        ...results.query,
        limit: AUDIT_DEFAULT_LIMIT,
        cursor: results.nextCursor,
      });
      setResults((current) =>
        current && current.query === results.query
          ? {
              ...current,
              items: [...current.items, ...page.items],
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch (cause) {
      setError(auditErrorMessage(cause, 'Unable to load more entries.'));
    } finally {
      setLoadingMore(false);
    }
  }

  const update = (key: keyof AuditFilterForm) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Administration"
        title="Audit log"
        description="Who did what, to which record, and when. Entries show identifiers and codes only — never personal details or document contents. Newest first."
      >
        {organizations && organizations.length > 0 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="audit-organization">
            Organization
            <select
              id="audit-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setOrganizationId(next);
                setResults(null);
                // The actor list belongs to one organization's trail: start the new one without it.
                const nextForm = { ...form, actorUserId: '' };
                setForm(nextForm);
                setActorOption(null);
                search(next, nextForm);
              }}
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>

      <div className="mt-6 space-y-4">
        {organizations === null ? (
          <Loading>Loading organizations…</Loading>
        ) : organizations.length === 0 ? (
          <EmptyState>
            No organizations are within your audit access. Reading an audit log needs the audit
            permission for the whole organization.
          </EmptyState>
        ) : (
          <>
            <form
              aria-label="Audit filters"
              className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                search();
              }}
            >
              <Field label="From (date)">
                <input
                  className={inputClass}
                  type="date"
                  value={form.fromDate}
                  onChange={update('fromDate')}
                />
              </Field>
              <Field label="To (date, inclusive)">
                <input
                  className={inputClass}
                  type="date"
                  value={form.toDate}
                  onChange={update('toDate')}
                />
              </Field>
              <Field label="Action">
                <input
                  className={inputClass}
                  placeholder="e.g. EMPLOYEE_CREATED"
                  list="audit-account-actions"
                  value={form.action}
                  onChange={update('action')}
                />
                {/* Batch 2: suggestions for the sign-in and account security actions. */}
                <datalist id="audit-account-actions">
                  {Object.entries(ACCOUNT_SECURITY_ACTIONS).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="Record type">
                <select
                  className={inputClass}
                  value={otherEntityType ? OTHER_ENTITY_TYPE : entityTypeChoice}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setOtherEntityType(value === OTHER_ENTITY_TYPE);
                    setForm((current) => ({
                      ...current,
                      entityType: value === OTHER_ENTITY_TYPE ? current.entityType : value,
                    }));
                  }}
                >
                  <option value="">Any record type</option>
                  {AUDIT_ENTITY_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {auditEntityTypeLabel(type)}
                    </option>
                  ))}
                  <option value={OTHER_ENTITY_TYPE}>Other (type the code)</option>
                </select>
              </Field>
              {(otherEntityType || entityTypeChoice === OTHER_ENTITY_TYPE) && (
                <Field label="Record type code">
                  <input
                    className={inputClass}
                    placeholder="e.g. Employee"
                    value={form.entityType}
                    onChange={update('entityType')}
                  />
                </Field>
              )}
              <Field label="Record id (optional)">
                <input
                  className={inputClass}
                  placeholder="The id of one record"
                  value={form.entityId}
                  onChange={update('entityId')}
                />
              </Field>
              <RecordCombobox
                label="Performed by"
                hint="People who acted in the searched period."
                placeholder="Type a name"
                noResultsText="No one with that name acted in this period."
                source={actorSource}
                value={form.actorUserId}
                selected={actorOption}
                onChange={(id, option) => {
                  setActorOption(option);
                  setForm((current) => ({ ...current, actorUserId: id }));
                }}
                manualEntry={{
                  label: 'User id',
                  hint: 'For someone not listed, e.g. outside the searched period.',
                }}
              />
              <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
                <button type="submit" className={primaryButton} disabled={loading}>
                  Search
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={loading}
                  onClick={() => {
                    setForm(EMPTY_AUDIT_FILTERS);
                    setActorOption(null);
                    setOtherEntityType(false);
                    search(organizationId, EMPTY_AUDIT_FILTERS);
                  }}
                >
                  Clear filters
                </button>
                <p className="text-xs text-slate-500">
                  Without dates, the last 30 days are shown. A search covers at most 366 days.
                </p>
              </div>
              {problem && (
                <p role="alert" className="text-sm text-rose-800 sm:col-span-2 lg:col-span-3">
                  {problem}
                </p>
              )}
            </form>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {loading ? (
              <Loading>Loading audit entries…</Loading>
            ) : results ? (
              <AuditResults
                results={results}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
              />
            ) : null}
          </>
        )}
      </div>
    </PageContainer>
  );
}

function AuditResults({
  results,
  loadingMore,
  onLoadMore,
}: {
  results: Results;
  loadingMore: boolean;
  onLoadMore(): void;
}) {
  return (
    <section aria-label="Audit entries" className="space-y-3">
      <p className="text-sm text-slate-600">
        Entries from {auditTimeText(results.range.from)} up to {auditTimeText(results.range.to)}
        {results.items.length > 0 &&
          ` · ${results.items.length} shown${results.nextCursor ? ' (more available)' : ''}`}
      </p>
      {results.items.length === 0 ? (
        <EmptyState>No audit entries match these filters.</EmptyState>
      ) : (
        <DataTable
          label="Audit log entries"
          rows={results.items}
          rowKey={(entry) => entry.id}
          rowLabel={(entry) => `Audit entry ${entry.action}`}
          columns={[
            {
              key: 'time',
              header: 'Time',
              className: 'whitespace-nowrap',
              cell: (entry) => (
                <>
                  <time dateTime={entry.occurredAt}>{auditTimeText(entry.occurredAt)}</time>
                </>
              ),
            },
            {
              key: 'action',
              header: 'Action',
              rowHeader: true,
              cell: (entry) => (
                <>
                  {auditActionLabel(entry.action) && (
                    <span className="block font-medium">{auditActionLabel(entry.action)}</span>
                  )}
                  <span className="block font-mono text-xs">{entry.action}</span>
                </>
              ),
            },
            {
              key: 'entity',
              header: 'Entity',
              cell: (entry) => (
                <>
                  {entry.entityType ? auditEntityTypeLabel(entry.entityType) : '—'}
                  {entry.entityType && (
                    <span className="block font-mono text-xs text-slate-500">
                      {entry.entityType}
                    </span>
                  )}
                  {entry.entityId && (
                    <span className="block break-all font-mono text-xs text-slate-500">
                      {entry.entityId}
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'actor',
              header: 'Actor',
              cell: (entry) => (
                <>
                  {entry.actor ? (
                    entry.actor.displayName ? (
                      <>
                        {entry.actor.displayName}
                        <span className="block break-all font-mono text-xs text-slate-500">
                          {entry.actor.userId}
                        </span>
                      </>
                    ) : (
                      <span className="break-all font-mono text-xs">{entry.actor.userId}</span>
                    )
                  ) : (
                    <span className="text-slate-500">System</span>
                  )}
                </>
              ),
            },
            {
              key: 'request',
              header: 'Request id',
              className: 'break-all font-mono text-xs',
              cell: (entry) => <>{entry.requestId ?? '—'}</>,
            },
            {
              key: 'details',
              header: 'Details',
              cell: (entry) => (
                <>
                  <MetadataList metadata={entry.metadata} />
                </>
              ),
            },
          ]}
        />
      )}
      {results.nextCursor && (
        <button
          type="button"
          className={secondaryButton}
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

/** Metadata as a key/value list. Plain text only: values are never interpreted as HTML. */
function MetadataList({ metadata }: { metadata: AuditEntry['metadata'] }) {
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) return <span className="text-slate-500">—</span>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-medium text-slate-600">{key}</dt>
          <dd className="break-all font-mono text-slate-800">{auditMetadataText(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `?organizationId=&entityType=&entityId=` filters a link may carry. */
export function linkedAuditFilters(search: string) {
  const params = new URLSearchParams(search);
  const value = (key: string) => (params.get(key) ?? '').trim().slice(0, 200);
  return {
    organizationId: value('organizationId'),
    entityType: value('entityType'),
    entityId: value('entityId'),
  };
}
