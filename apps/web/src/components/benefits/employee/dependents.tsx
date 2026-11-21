'use client';

import { checkboxClass } from '../../ui/tokens';
import { useState } from 'react';
import { benefitsApi, type DependentInput } from '../../../lib/benefits/api';
import { benefitsErrorMessage } from '../../../lib/benefits/errors';
import type { Dependent, Relationship } from '../../../lib/benefits/types';
import { formatDateOnly } from '../../../lib/payroll/format';
import { EmptyState } from '../../payroll/payroll-shared';
import { FormDialog } from '../../ui/form-dialog';
import { inputClass, secondaryButton } from '../../ui/tokens';
import { useConfirm } from '../../ui/use-confirm';
import { Field, fullName, RELATIONSHIP_LABELS } from './shared';
import { DataTable } from '../../ui/data-table';

/**
 * Batch 7C — an employee's dependents: names, relationship and its dates, and the birth date
 * only when the API shares it (benefits managers; never readers). Edit and archive follow each
 * dependent's own `canManage` (every assignment sponsoring their coverage must be in scope).
 */
export function DependentsPanel({
  employeeId,
  dependents,
  canManage,
  showArchived,
  onShowArchived,
  busy,
  run,
  onSaved,
}: {
  employeeId: string;
  dependents: Dependent[];
  canManage: boolean;
  showArchived: boolean;
  onShowArchived(value: boolean): void;
  busy: boolean;
  run(action: () => Promise<unknown>, message: string): Promise<boolean>;
  onSaved(message: string): Promise<void>;
}) {
  const [editing, setEditing] = useState<Dependent | 'new' | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const showBirthDates = dependents.some((dependent) => dependent.dateOfBirth !== null);
  const shown = showArchived ? dependents : dependents.filter((d) => !d.archived);

  return (
    <section aria-labelledby="dependents-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="dependents-heading" className="text-lg font-semibold text-slate-900">
          Dependents
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={showArchived}
              onChange={(event) => onShowArchived(event.currentTarget.checked)}
            />
            Show archived dependents
          </label>
          {canManage && (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() => setEditing('new')}
            >
              Add dependent
            </button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState>
          {dependents.length > 0
            ? 'Only archived dependents are recorded. Show archived dependents to see them.'
            : 'No dependents are recorded.'}
        </EmptyState>
      ) : (
        <DataTable
          label="Recorded dependents"
          rows={shown}
          rowKey={(dependent) => dependent.id}
          columns={[
            {
              key: 'name',
              header: 'Name',
              rowHeader: true,
              cell: (dependent) => (
                <>
                  {fullName(dependent)}
                  {dependent.archived && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      Archived
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'relationship',
              header: 'Relationship',
              cell: (dependent) => <>{RELATIONSHIP_LABELS[dependent.relationship]}</>,
            },
            {
              key: 'dates',
              header: 'Relationship dates',
              cell: (dependent) => (
                <>
                  {dependent.relationshipStartDate || dependent.relationshipEndDate
                    ? `${dependent.relationshipStartDate ? formatDateOnly(dependent.relationshipStartDate) : '—'} – ${dependent.relationshipEndDate ? formatDateOnly(dependent.relationshipEndDate) : 'ongoing'}`
                    : '—'}
                </>
              ),
            },
            // Dates of birth only where they are shown (as before).
            ...(showBirthDates
              ? [
                  {
                    key: 'birth',
                    header: 'Date of birth',
                    cell: (dependent: Dependent) => formatDateOnly(dependent.dateOfBirth),
                  },
                ]
              : []),
            {
              key: 'actions',
              header: 'Actions',
              className: 'space-x-1',
              cell: (dependent) => (
                <>
                  {dependent.canManage !== false && canManage && !dependent.archived ? (
                    <>
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Edit ${fullName(dependent)}`}
                        onClick={() => setEditing(dependent)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Archive ${fullName(dependent)}`}
                        onClick={() =>
                          void confirm({
                            title: `Archive ${fullName(dependent)}?`,
                            description:
                              'The dependent can no longer be added to coverage. Past and current coverage records keep them.',
                            confirmLabel: 'Archive dependent',
                          }).then((ok) => {
                            if (ok)
                              void run(
                                () => benefitsApi.archiveDependent(dependent.id),
                                'Dependent archived.',
                              );
                          })
                        }
                      >
                        Archive
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">
                      {dependent.archived ? '—' : canManage ? 'Covered outside your scope' : '—'}
                    </span>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {confirmDialog}
      {editing && (
        <DependentDialog
          dependent={editing === 'new' ? null : editing}
          // Only those who maintain dependents open this dialog, and they see birth dates (C4):
          // the field is always offered, also to add one that was never recorded.
          askBirthDate
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === 'new') await benefitsApi.addDependent(employeeId, input);
            else await benefitsApi.updateDependent(editing.id, input);
            setEditing(null);
            await onSaved(editing === 'new' ? 'Dependent added.' : 'Dependent updated.');
          }}
        />
      )}
    </section>
  );
}

export function DependentDialog({
  dependent,
  askBirthDate,
  onClose,
  onSave,
}: {
  dependent: Dependent | null;
  askBirthDate: boolean;
  onClose(): void;
  /** Saves (throws on failure: the dialog shows the error and stays open). */
  onSave(input: DependentInput): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [firstName, setFirstName] = useState(dependent?.firstName ?? '');
  const [lastName, setLastName] = useState(dependent?.lastName ?? '');
  const [relationship, setRelationship] = useState<Relationship>(
    dependent?.relationship ?? 'SPOUSE',
  );
  const [dateOfBirth, setDateOfBirth] = useState(dependent?.dateOfBirth ?? '');
  const [start, setStart] = useState(dependent?.relationshipStartDate ?? '');
  const [end, setEnd] = useState(dependent?.relationshipEndDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const childNeedsBirth = relationship === 'CHILD' && askBirthDate && !dateOfBirth;
  const range = start && end && end < start;
  return (
    <FormDialog
      open
      title={dependent ? `Edit ${fullName(dependent)}` : 'Add dependent'}
      description="Dependents are kept only for benefits. A relationship end date (for example a divorce) is recorded here; coverage is then changed on the election."
      submitLabel={dependent ? 'Save dependent' : 'Add dependent'}
      busy={busy}
      canSubmit={Boolean(firstName.trim() && lastName.trim()) && !childNeedsBirth && !range}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        setError(null);
        const input: DependentInput = {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          relationship,
          relationshipStartDate: start || null,
          relationshipEndDate: end || null,
          ...(askBirthDate ? { dateOfBirth: dateOfBirth || null } : {}),
        };
        setBusy(true);
        void onSave(input)
          .catch((cause: unknown) =>
            setError(benefitsErrorMessage(cause, 'Unable to save the dependent.')),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="First name">
          <input
            required
            className={inputClass}
            value={firstName}
            onChange={(event) => setFirstName(event.currentTarget.value)}
          />
        </Field>
        <Field label="Last name">
          <input
            required
            className={inputClass}
            value={lastName}
            onChange={(event) => setLastName(event.currentTarget.value)}
          />
        </Field>
        <Field
          label="Relationship"
          hint={
            dependent ? 'A dependent who has been covered keeps their relationship.' : undefined
          }
        >
          <select
            className={inputClass}
            value={relationship}
            onChange={(event) => setRelationship(event.currentTarget.value as Relationship)}
          >
            {(Object.keys(RELATIONSHIP_LABELS) as Relationship[]).map((key) => (
              <option key={key} value={key}>
                {RELATIONSHIP_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        {askBirthDate && (
          <Field label={`Date of birth${relationship === 'CHILD' ? '' : ' (optional)'}`}>
            <input
              type="date"
              required={relationship === 'CHILD'}
              className={inputClass}
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.currentTarget.value)}
            />
          </Field>
        )}
        <Field label="Relationship start (optional)">
          <input
            type="date"
            className={inputClass}
            value={start}
            onChange={(event) => setStart(event.currentTarget.value)}
          />
        </Field>
        <Field
          label="Relationship end (optional)"
          hint={range ? 'The end must not be before the start.' : 'For example a divorce.'}
        >
          <input
            type="date"
            className={inputClass}
            value={end}
            aria-invalid={range ? true : undefined}
            onChange={(event) => setEnd(event.currentTarget.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
