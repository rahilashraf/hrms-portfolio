'use client';

import type { FormEvent } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { TruncatedNotice } from '../../organization/shared';
import { recruitmentApi, type OpeningFields } from '../../../lib/recruitment/api';
import type {
  EmploymentType,
  Opening,
  OpeningAction,
  OpeningDetail,
  OpeningStatus,
  PayBasis,
} from '../../../lib/recruitment/types';
import {
  dateTimeText,
  EMPLOYMENT_TYPES,
  EmptyState,
  Field,
  formatDateOnly,
  inputClass,
  label,
  OpeningStatusBadge,
  primaryButton,
  secondaryButton,
} from '../recruitment-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import type { PickerOption } from '../../../lib/pickers/sources';
import {
  recruitmentOptionSource,
  type RecruitmentPickerOption,
} from '../../../lib/recruitment/pickers';
import { RecordCombobox } from '../../ui/record-combobox';
import { Loading, Mutate, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: openings, their details and the opening editor (moved from
// recruitment-admin-page.tsx unchanged).
const OPENING_STATUSES: OpeningStatus[] = [
  'DRAFT',
  'OPEN',
  'ON_HOLD',
  'FILLED',
  'CLOSED',
  'CANCELLED',
];

/** Lifecycle actions offered per opening status (mirrors the API's transitions). */
const OPENING_ACTIONS: Record<OpeningStatus, OpeningAction[]> = {
  DRAFT: ['open', 'cancel'],
  OPEN: ['hold', 'close', 'cancel'],
  ON_HOLD: ['resume', 'close', 'cancel'],
  FILLED: ['close'],
  CLOSED: [],
  CANCELLED: [],
};
const OPENING_ACTION_LABELS: Record<OpeningAction, string> = {
  open: 'Open',
  hold: 'Put on hold',
  resume: 'Resume',
  close: 'Close',
  cancel: 'Cancel',
};
const OPENING_ACTION_MESSAGES: Record<OpeningAction, string> = {
  open: 'Opening opened.',
  hold: 'Opening put on hold.',
  resume: 'Opening resumed.',
  close: 'Opening closed.',
  cancel: 'Opening cancelled.',
};
const REASON_REQUIRED: OpeningAction[] = ['hold', 'cancel'];
const OPENING_ACTION_EFFECTS: Record<OpeningAction, string> = {
  open: 'The opening accepts applications.',
  hold: 'The opening stops moving forward until it is resumed. Applications are kept.',
  resume: 'The opening accepts applications again.',
  close: 'The opening is closed for good. Its applications and history are kept.',
  cancel:
    'The opening is cancelled for good and cannot be reopened. Its applications and history are kept.',
};

type StructureKind = 'unit' | 'department' | 'team';
const STRUCTURE_LABELS: Record<StructureKind, string> = {
  unit: 'Business unit',
  department: 'Department',
  team: 'Team',
};
const STRUCTURE_FIELD: Record<StructureKind, 'organizationalUnitId' | 'departmentId' | 'teamId'> = {
  unit: 'organizationalUnitId',
  department: 'departmentId',
  team: 'teamId',
};

/** What an existing opening's pickers show for its current choices (names, never an id). */
function openingSelections(opening: Opening | null) {
  const named = (value: { id: string; name: string } | null | undefined): PickerOption | null =>
    value ? { id: value.id, label: value.name } : null;
  const structure = opening?.team ?? opening?.department ?? opening?.organizationalUnit ?? null;
  return {
    position: opening?.position
      ? {
          id: opening.position.id,
          label: opening.position.name,
          description: opening.position.code,
        }
      : null,
    structure: named(structure),
    workLocation: named(opening?.workLocation),
    hiringManager: opening?.hiringManager
      ? { id: opening.hiringManager.id, label: opening.hiringManager.displayName }
      : null,
  };
}

interface OpeningForm {
  code: string;
  title: string;
  employmentType: EmploymentType;
  openingCount: string;
  description: string;
  positionId: string;
  organizationalUnitId: string;
  departmentId: string;
  teamId: string;
  workLocationId: string;
  hiringManagerEmployeeId: string;
  /** Batch 7A: the structure level the opening is placed on when it has no position. */
  structureKind: StructureKind;
  expectedStartDate: string;
  postedOn: string;
  closesOn: string;
  payBasis: PayBasis;
  min: string;
  max: string;
  currency: string;
}

const emptyOpening: OpeningForm = {
  code: '',
  title: '',
  employmentType: 'FULL_TIME',
  openingCount: '1',
  description: '',
  positionId: '',
  organizationalUnitId: '',
  departmentId: '',
  teamId: '',
  workLocationId: '',
  hiringManagerEmployeeId: '',
  structureKind: 'team',
  expectedStartDate: '',
  postedOn: '',
  closesOn: '',
  payBasis: 'HOURLY',
  min: '',
  max: '',
  currency: 'CAD',
};

function openingToForm(opening: Opening): OpeningForm {
  return {
    code: opening.code,
    title: opening.title,
    employmentType: opening.employmentType,
    openingCount: String(opening.openingCount),
    description: opening.description ?? '',
    positionId: opening.position?.id ?? '',
    organizationalUnitId: opening.organizationalUnit?.id ?? '',
    departmentId: opening.department?.id ?? '',
    teamId: opening.team?.id ?? '',
    workLocationId: opening.workLocation?.id ?? '',
    hiringManagerEmployeeId: opening.hiringManager?.id ?? '',
    structureKind: opening.team
      ? 'team'
      : opening.department
        ? 'department'
        : opening.organizationalUnit
          ? 'unit'
          : 'team',
    expectedStartDate: opening.expectedStartDate ?? '',
    postedOn: opening.postedOn ?? '',
    closesOn: opening.closesOn ?? '',
    payBasis: opening.compensation?.payBasis ?? 'HOURLY',
    min: opening.compensation?.min ?? '',
    max: opening.compensation?.max ?? '',
    currency: opening.compensation?.currency ?? 'CAD',
  };
}

function openingFields(form: OpeningForm): OpeningFields {
  const hasRange = form.min.trim() !== '' || form.max.trim() !== '';
  return {
    description: form.description.trim() || null,
    positionId: form.positionId.trim() || null,
    organizationalUnitId: form.organizationalUnitId.trim() || null,
    departmentId: form.departmentId.trim() || null,
    teamId: form.teamId.trim() || null,
    workLocationId: form.workLocationId.trim() || null,
    hiringManagerEmployeeId: form.hiringManagerEmployeeId.trim() || null,
    openingCount: Number(form.openingCount) || 1,
    expectedStartDate: form.expectedStartDate || null,
    postedOn: form.postedOn || null,
    closesOn: form.closesOn || null,
    compensation: hasRange
      ? {
          payBasis: form.payBasis,
          min: form.min.trim() || null,
          max: form.max.trim() || null,
          currency: form.currency.trim().toUpperCase(),
        }
      : null,
  };
}

function compensationText(opening: Opening) {
  const range = opening.compensation;
  if (!range) return '—';
  const amounts = [range.min, range.max].filter(Boolean).join(' – ');
  return `${range.currency} ${amounts} ${range.payBasis === 'HOURLY' ? '/ hour' : '/ year'}`;
}

export function OpeningsTab({
  organizationId,
  canCreate,
  filter,
  onFilter,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  canCreate: boolean;
  filter: { status: OpeningStatus | ''; search: string };
  onFilter(filter: { status: OpeningStatus | ''; search: string }): void;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(
    () =>
      recruitmentApi.openings(organizationId, {
        status: filter.status || undefined,
        search: filter.search.trim() || undefined,
      }),
    [organizationId, filter.status, filter.search],
  );
  const { data, loaded } = useData(load, onError);
  const [editing, setEditing] = useState<Opening | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const openings = data?.items ?? [];

  function transition(opening: Opening, action: OpeningAction, reason = '') {
    void mutate(
      () => recruitmentApi.transitionOpening(opening.id, action, reason || undefined),
      OPENING_ACTION_MESSAGES[action],
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Status">
          <select
            className={inputClass}
            value={filter.status}
            onChange={(e) =>
              onFilter({ ...filter, status: e.currentTarget.value as OpeningStatus | '' })
            }
          >
            <option value="">All statuses</option>
            {OPENING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search openings">
          <input
            className={inputClass}
            type="search"
            value={filter.search}
            onChange={(e) => onFilter({ ...filter, search: e.currentTarget.value })}
          />
        </Field>
        {canCreate && (
          <button type="button" className={primaryButton} onClick={() => setEditing('new')}>
            New opening
          </button>
        )}
      </div>
      {loaded && <TruncatedNotice truncated={data?.truncated} shown={openings.length} />}
      {!loaded ? (
        <Loading />
      ) : openings.length === 0 ? (
        <EmptyState>No openings match.</EmptyState>
      ) : (
        <DataTable
          label="Openings"
          minWidth="min-w-[880px]"
          rows={openings}
          rowKey={(opening) => opening.id}
          columns={[
            {
              key: 'opening',
              header: 'Opening',
              rowHeader: true,
              cell: (opening) => (
                <>
                  {opening.title}
                  <span className="block text-xs font-normal text-slate-500">
                    {opening.code}
                    {opening.position ? ` · ${opening.position.name}` : ''}
                    {opening.hiringManager
                      ? ` · Manager: ${opening.hiringManager.displayName}`
                      : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (opening) => (
                <>
                  <OpeningStatusBadge status={opening.status} />
                  {opening.statusReason && (
                    <span className="block text-xs text-slate-500">{opening.statusReason}</span>
                  )}
                </>
              ),
            },
            {
              key: 'type',
              header: 'Type',
              cell: (opening) => <>{label(opening.employmentType)}</>,
            },
            {
              key: 'filled',
              header: 'Filled',
              cell: (opening) => (
                <>
                  {opening.hiredCount} / {opening.openingCount}
                </>
              ),
            },
            {
              key: 'posted',
              header: 'Posted',
              cell: (opening) => <>{formatDateOnly(opening.postedOn)}</>,
            },
            {
              key: 'closes',
              header: 'Closes',
              cell: (opening) => <>{formatDateOnly(opening.closesOn)}</>,
            },
            {
              key: 'pay',
              header: 'Pay',
              cell: (opening) => <>{compensationText(opening)}</>,
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              className: 'space-x-1 whitespace-nowrap',
              cell: (opening) => (
                <>
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={`Details of ${opening.title}`}
                    aria-expanded={viewing === opening.id}
                    onClick={() => setViewing(viewing === opening.id ? null : opening.id)}
                  >
                    Details
                  </button>
                  {opening.actions?.canManage && (
                    <>
                      {!['CLOSED', 'CANCELLED'].includes(opening.status) && (
                        <button
                          type="button"
                          className={secondaryButton}
                          aria-label={`Edit ${opening.title}`}
                          onClick={() => setEditing(opening)}
                        >
                          Edit
                        </button>
                      )}
                      {OPENING_ACTIONS[opening.status].map((action) =>
                        action === 'open' || action === 'resume' ? (
                          <button
                            key={action}
                            type="button"
                            className={action === 'open' ? primaryButton : secondaryButton}
                            disabled={busy}
                            aria-label={`${OPENING_ACTION_LABELS[action]} ${opening.title}`}
                            onClick={() => transition(opening, action)}
                          >
                            {OPENING_ACTION_LABELS[action]}
                          </button>
                        ) : (
                          // Batch 7A: hold, close and cancel are confirmed (hold and cancel
                          // with the reason the API requires).
                          <ConfirmButton
                            key={action}
                            className={secondaryButton}
                            disabled={busy}
                            aria-label={`${OPENING_ACTION_LABELS[action]} ${opening.title}`}
                            confirm={{
                              title: `${OPENING_ACTION_LABELS[action]} ${opening.title}?`,
                              description: OPENING_ACTION_EFFECTS[action],
                              confirmLabel: `${OPENING_ACTION_LABELS[action]} opening`,
                              destructive: action === 'cancel',
                              ...(REASON_REQUIRED.includes(action)
                                ? { reason: { label: 'Reason', required: true } }
                                : {}),
                            }}
                            onConfirm={(reason) => transition(opening, action, reason)}
                          >
                            {OPENING_ACTION_LABELS[action]}
                          </ConfirmButton>
                        ),
                      )}
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {viewing && (
        <OpeningDetailPanel
          key={viewing}
          openingId={viewing}
          onClose={() => setViewing(null)}
          onError={onError}
        />
      )}
      {editing && (
        <OpeningEditor
          key={editing === 'new' ? 'new' : editing.id}
          organizationId={organizationId}
          opening={editing === 'new' ? null : editing}
          busy={busy}
          mutate={mutate}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Batch 7A — one opening in full (GET /recruitment/openings/:id), with its history. */
function OpeningDetailPanel({
  openingId,
  onClose,
  onError,
}: {
  openingId: string;
  onClose(): void;
  onError(message: string): void;
}) {
  const load = useCallback(() => recruitmentApi.opening(openingId), [openingId]);
  const { data, loaded } = useData<OpeningDetail>(load, onError);
  return (
    <section
      aria-label="Opening details"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      {!loaded ? (
        <Loading />
      ) : !data ? (
        <EmptyState>The opening is unavailable.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{data.title}</h2>
              <p className="text-sm text-slate-600">
                {data.code} · {label(data.employmentType)} ·{' '}
                <OpeningStatusBadge status={data.status} />
              </p>
            </div>
            <button type="button" className={secondaryButton} onClick={onClose}>
              Close details
            </button>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {(
              [
                [
                  'Position',
                  data.position ? `${data.position.name} (${data.position.code})` : null,
                ],
                ['Business unit', data.organizationalUnit?.name],
                ['Department', data.department?.name],
                ['Team', data.team?.name],
                ['Work location', data.workLocation?.name],
                ['Hiring manager', data.hiringManager?.displayName],
                ['Openings filled', `${data.hiredCount} / ${data.openingCount}`],
                ['Pay', compensationText(data)],
                ['Posted', formatDateOnly(data.postedOn)],
                ['Closes', formatDateOnly(data.closesOn)],
                ['Expected start', formatDateOnly(data.expectedStartDate)],
                ['Status reason', data.statusReason],
              ] as Array<[string, string | null | undefined]>
            ).map(([term, value]) => (
              <div key={term} className="flex gap-2">
                <dt className="font-medium text-slate-700">{term}:</dt>
                <dd className="text-slate-900">{value || '—'}</dd>
              </div>
            ))}
          </dl>
          {data.description && <p className="text-sm text-slate-800">{data.description}</p>}
          <h3 className="text-sm font-semibold text-slate-900">History</h3>
          {data.events.length === 0 ? (
            <p className="text-sm text-slate-500">No history yet.</p>
          ) : (
            <ol aria-label="Opening history" className="space-y-1 text-sm text-slate-800">
              {data.events.map((event) => (
                <li key={event.id}>
                  {dateTimeText(event.createdAt)} · {label(event.type)}
                  {event.toStatus ? ` → ${label(event.toStatus)}` : ''}
                  {event.reason ? ` (${event.reason})` : ''}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function OpeningEditor({
  organizationId,
  opening,
  busy,
  mutate,
  onDone,
}: {
  organizationId: string;
  opening: Opening | null;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [form, setForm] = useState<OpeningForm>(opening ? openingToForm(opening) : emptyOpening);
  const set = (key: keyof OpeningForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Batch 7A: pickers from GET /recruitment/options (recruitment.manage only; no raw ids).
  const sources = useMemo(
    () => ({
      position: recruitmentOptionSource(organizationId, 'position'),
      unit: recruitmentOptionSource(organizationId, 'unit'),
      department: recruitmentOptionSource(organizationId, 'department'),
      team: recruitmentOptionSource(organizationId, 'team'),
      workLocation: recruitmentOptionSource(organizationId, 'workLocation'),
      hiringManager: recruitmentOptionSource(organizationId, 'hiringManager'),
    }),
    [organizationId],
  );
  const selected = useMemo(() => openingSelections(opening), [opening]);
  /** A unit, department or team carries its ancestry: the opening's scope matches it. */
  function chooseStructure(id: string, option: RecruitmentPickerOption | null) {
    const placement = id && option?.placement;
    setForm((current) => ({
      ...current,
      organizationalUnitId: placement ? (placement.organizationalUnitId ?? '') : '',
      departmentId: placement ? (placement.departmentId ?? '') : '',
      teamId: placement ? (placement.teamId ?? '') : '',
      ...(id && !placement ? { [STRUCTURE_FIELD[current.structureKind]]: id } : {}),
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const fields = openingFields(form);
    const ok = await mutate(
      () =>
        opening
          ? recruitmentApi.updateOpening(opening.id, {
              ...fields,
              title: form.title.trim(),
              employmentType: form.employmentType,
            })
          : recruitmentApi.createOpening({
              organizationId,
              code: form.code.trim(),
              title: form.title.trim(),
              employmentType: form.employmentType,
              ...fields,
            }),
      opening ? 'Opening updated.' : 'Opening created as a draft.',
    );
    if (ok) onDone();
  }
  const text = (key: keyof OpeningForm, title: string, type = 'text', required = false) => (
    <Field key={key} label={title}>
      <input
        className={inputClass}
        type={type}
        required={required}
        value={form[key]}
        onChange={(e) => set(key)(e.currentTarget.value)}
      />
    </Field>
  );
  return (
    <form
      aria-label={opening ? 'Edit opening' : 'Create opening'}
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4"
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-4">
        {opening ? `Edit ${opening.title}` : 'New opening'}
      </h2>
      {!opening && text('code', 'Requisition code', 'text', true)}
      {text('title', 'Job title', 'text', true)}
      <Field label="Employment type">
        <select
          className={inputClass}
          value={form.employmentType}
          onChange={(e) => set('employmentType')(e.currentTarget.value)}
        >
          {EMPLOYMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Number of openings">
        <input
          className={inputClass}
          type="number"
          min={1}
          max={1000}
          value={form.openingCount}
          onChange={(e) => set('openingCount')(e.currentTarget.value)}
        />
      </Field>
      <div className="sm:col-span-2">
        <RecordCombobox
          label="Position (optional)"
          hint="An opening on a position takes the position's placement."
          source={sources.position}
          value={form.positionId}
          selected={selected.position}
          onChange={(id) => set('positionId')(id)}
          placeholder="Search positions"
          noResultsText="No positions you can place an opening on."
        />
      </div>
      {form.positionId ? (
        <p className="self-end text-sm text-slate-600 sm:col-span-2">Placed by the position.</p>
      ) : (
        <>
          <Field label="Placed in">
            <select
              className={inputClass}
              value={form.structureKind}
              onChange={(e) => {
                const structureKind = e.currentTarget.value as StructureKind;
                setForm((current) => ({
                  ...current,
                  structureKind,
                  organizationalUnitId: '',
                  departmentId: '',
                  teamId: '',
                }));
              }}
            >
              {(Object.keys(STRUCTURE_LABELS) as StructureKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {STRUCTURE_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
          <RecordCombobox
            key={form.structureKind}
            label={`${STRUCTURE_LABELS[form.structureKind]} (optional)`}
            source={sources[form.structureKind]}
            value={form[STRUCTURE_FIELD[form.structureKind]]}
            selected={selected.structure}
            onChange={(id, option) => chooseStructure(id, option as RecruitmentPickerOption | null)}
            placeholder={`Search ${STRUCTURE_LABELS[form.structureKind].toLowerCase()}s`}
            noResultsText="Nothing you can place an opening on."
          />
        </>
      )}
      <RecordCombobox
        label="Work location (optional)"
        source={sources.workLocation}
        value={form.workLocationId}
        selected={selected.workLocation}
        onChange={(id) => set('workLocationId')(id)}
        placeholder="Search work locations"
        noResultsText="No matching work locations."
      />
      <RecordCombobox
        label="Hiring manager (optional)"
        source={sources.hiringManager}
        value={form.hiringManagerEmployeeId}
        selected={selected.hiringManager}
        onChange={(id) => set('hiringManagerEmployeeId')(id)}
        placeholder="Name or employee number"
        noResultsText="No matching employees of the organization."
      />
      {text('postedOn', 'Posted on', 'date')}
      {text('closesOn', 'Closes on', 'date')}
      {text('expectedStartDate', 'Expected start', 'date')}
      <Field label="Pay basis">
        <select
          className={inputClass}
          value={form.payBasis}
          onChange={(e) => set('payBasis')(e.currentTarget.value)}
        >
          <option value="HOURLY">Hourly</option>
          <option value="SALARY">Salary</option>
        </select>
      </Field>
      {text('min', 'Pay range minimum')}
      {text('max', 'Pay range maximum')}
      {text('currency', 'Currency')}
      <div className="sm:col-span-4">
        <Field label="Description">
          <textarea
            className={inputClass}
            rows={3}
            value={form.description}
            onChange={(e) => set('description')(e.currentTarget.value)}
          />
        </Field>
      </div>
      <div className="flex gap-2 sm:col-span-4">
        <button type="submit" className={primaryButton} disabled={busy}>
          {opening ? 'Save opening' : 'Create opening'}
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel editing
        </button>
      </div>
    </form>
  );
}
