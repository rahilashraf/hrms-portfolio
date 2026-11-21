'use client';

import { checkboxClass } from '../ui/tokens';

import { buttonClass } from '../ui/button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { PageHeader, ErrorBanner } from '../organization/shared';
import { employeeApi } from '../../lib/employee/api';
import { employeeActionErrorMessage } from '../../lib/employee/errors';
import type {
  EmployeeCreateInput,
  EmployeePersonInput,
  EmployeePersonOption,
  EmployeePositionOption,
  EmploymentType,
} from '../../lib/employee/types';
import { useAuth } from '../../providers/auth-provider';
import { displayName } from './employee-shared';
import { EmployeePositionPicker } from './employee-position-picker';
import type { RecordSource } from '../../lib/pickers/use-record-search';
import { SearchPickList } from '../ui/search-pick-list';
import { RequirePermission } from '../ui/require-permission';
import { PageContainer } from '../ui/page-container';

const optionLimit = 10;
const employmentTypes: Array<{ value: EmploymentType; label: string }> = [
  { value: 'FULL_TIME', label: 'Full-time' },
  { value: 'PART_TIME', label: 'Part-time' },
  { value: 'CASUAL', label: 'Casual' },
  { value: 'CONTRACT', label: 'Contract' },
];

type PersonMode = 'new' | 'existing';

interface PersonFormState {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  personalEmail: string;
  phone: string;
}

interface AssignmentFormState {
  position: EmployeePositionOption | null;
  employmentType: EmploymentType | '';
  startDate: string;
  endDate: string;
  primary: boolean;
}

const emptyPerson: PersonFormState = {
  firstName: '',
  middleName: '',
  lastName: '',
  preferredName: '',
  personalEmail: '',
  phone: '',
};

const emptyAssignment: AssignmentFormState = {
  position: null,
  employmentType: '',
  startDate: '',
  endDate: '',
  primary: true,
};

export function EmployeeOnboardingPage() {
  const { can } = useAuth();
  // Batch 10A: loading in the page's own width while access is checked (no "Access denied"
  // flash, no width jump). The API checks employee.manage on every request.
  return (
    <RequirePermission
      anyOf={['employee.manage']}
      deniedMessage="You do not have permission to manage employees."
    >
      <EmployeeOnboardingForm systemManage={can('employee.manage')} />
    </RequirePermission>
  );
}

function EmployeeOnboardingForm({ systemManage }: { systemManage: boolean }) {
  const router = useRouter();
  const [personMode, setPersonMode] = useState<PersonMode>('new');
  const [person, setPerson] = useState<PersonFormState>(emptyPerson);
  const [selectedPerson, setSelectedPerson] = useState<EmployeePersonOption | null>(null);
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [hireDate, setHireDate] = useState('');
  const [assignmentEnabled, setAssignmentEnabled] = useState(!systemManage);
  const [assignment, setAssignment] = useState<AssignmentFormState>(emptyAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchPersonMode(mode: PersonMode) {
    setPersonMode(mode);
    setError(null);
    if (mode === 'new') setSelectedPerson(null);
    else setPerson(emptyPerson);
  }

  function setPersonField(field: keyof PersonFormState, value: string) {
    setPerson((current) => ({ ...current, [field]: value }));
  }

  function setAssignmentField<K extends keyof AssignmentFormState>(
    field: K,
    value: AssignmentFormState[K],
  ) {
    setAssignment((current) => ({ ...current, [field]: value }));
  }

  function toggleAssignment(enabled: boolean) {
    setAssignmentEnabled(enabled);
    if (!enabled) setAssignment(emptyAssignment);
    else setAssignment((current) => ({ ...current, primary: true }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const validation = validateForm({
      systemManage,
      personMode,
      person,
      selectedPerson,
      hireDate,
      assignmentEnabled,
      assignment,
    });
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await employeeApi.create(
        buildCreatePayload({
          personMode,
          person,
          selectedPerson,
          employeeNumber,
          hireDate,
          assignmentEnabled,
          assignment,
        }),
      );
      router.push(`/admin/employees/${created.id}`);
    } catch (cause) {
      setError(employeeActionErrorMessage(cause, 'Unable to create employee.'));
    } finally {
      setBusy(false);
    }
  }

  const assignmentRequired = !systemManage;
  return (
    <PageContainer>
      <div>
        <PageHeader
          eyebrow="Employees"
          title="Add employee"
          description="Create the employee record and optional initial assignment."
        />
      </div>
      <form onSubmit={submit} className="mt-8 space-y-6">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Person</h2>
              <p className="mt-1 text-sm text-slate-600">
                Use basic identity details for the employee record.
              </p>
            </div>
            {systemManage && (
              <div className="inline-flex rounded-lg border border-slate-300 p-1">
                <button
                  type="button"
                  onClick={() => switchPersonMode('new')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${personMode === 'new' ? 'bg-indigo-700 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  New person
                </button>
                <button
                  type="button"
                  onClick={() => switchPersonMode('existing')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${personMode === 'existing' ? 'bg-indigo-700 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  Existing person
                </button>
              </div>
            )}
          </div>
          {personMode === 'existing' && systemManage ? (
            <PersonOptionPicker selected={selectedPerson} onSelect={setSelectedPerson} />
          ) : (
            <PersonFields person={person} onChange={setPersonField} />
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Employment</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Employee number (optional)
              <input
                value={employeeNumber}
                onChange={(event) => setEmployeeNumber(event.target.value)}
                placeholder="Leave blank to auto-generate"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Hire date
              <input
                type="date"
                value={hireDate}
                onChange={(event) => setHireDate(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Initial assignment</h2>
              <p className="mt-1 text-sm text-slate-600">
                {assignmentRequired
                  ? 'A manageable initial assignment is required.'
                  : 'Create the employee with or without an initial assignment.'}
              </p>
            </div>
            {!assignmentRequired && (
              <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={assignmentEnabled}
                  onChange={(event) => toggleAssignment(event.currentTarget.checked)}
                  className={checkboxClass}
                />
                Create with initial assignment
              </label>
            )}
          </div>
          {assignmentEnabled && (
            <AssignmentFields assignment={assignment} onChange={setAssignmentField} />
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Review</h2>
          <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-slate-700 sm:grid-cols-2">
            <p>
              <span className="font-medium text-slate-950">Person: </span>
              {personMode === 'existing' && selectedPerson
                ? displayName(selectedPerson)
                : [person.firstName.trim(), person.lastName.trim()].filter(Boolean).join(' ') ||
                  'New person'}
            </p>
            <p>
              <span className="font-medium text-slate-950">Hire date: </span>
              {hireDate || 'Not set'}
            </p>
            <p>
              <span className="font-medium text-slate-950">Employee number: </span>
              {employeeNumber.trim() || 'Auto-generated'}
            </p>
            <p className="sm:col-span-2">
              <span className="font-medium text-slate-950">Assignment: </span>
              {assignmentEnabled
                ? assignment.position?.name || 'Position not selected'
                : 'No initial assignment'}
            </p>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <Link
              href="/admin/employees"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
            <button type="submit" disabled={busy} className={buttonClass('primary')}>
              {busy ? 'Creating...' : 'Create employee'}
            </button>
          </div>
        </section>
      </form>
    </PageContainer>
  );
}

function PersonFields({
  person,
  onChange,
}: {
  person: PersonFormState;
  onChange(field: keyof PersonFormState, value: string): void;
}) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-700">
        First name
        <input
          value={person.firstName}
          onChange={(event) => onChange('firstName', event.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Last name
        <input
          value={person.lastName}
          onChange={(event) => onChange('lastName', event.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Middle name
        <input
          value={person.middleName}
          onChange={(event) => onChange('middleName', event.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Preferred name
        <input
          value={person.preferredName}
          onChange={(event) => onChange('preferredName', event.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Personal email
        <input
          type="email"
          value={person.personalEmail}
          onChange={(event) => onChange('personalEmail', event.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Phone
        <input
          type="tel"
          value={person.phone}
          onChange={(event) => onChange('phone', event.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
    </div>
  );
}

function PersonOptionPicker({
  selected,
  onSelect,
}: {
  selected: EmployeePersonOption | null;
  onSelect(person: EmployeePersonOption): void;
}) {
  const source = useMemo<RecordSource<EmployeePersonOption>>(
    () => ({
      async search(query, cursor) {
        const result = await employeeApi.listPersonOptions({
          ...(query ? { search: query } : {}),
          limit: optionLimit,
          ...(cursor ? { afterId: cursor } : {}),
        });
        return { items: result.items, next: result.nextAfterId };
      },
    }),
    [],
  );
  return (
    <div className="mt-5">
      <SearchPickList
        searchLabel="Search people"
        placeholder="Search by name or personal email"
        source={source}
        getKey={(person) => person.id}
        isSelected={(person) => selected?.id === person.id}
        unavailableReason={(person) =>
          person.hasEmployee ? 'Already has an employee record' : null
        }
        emptyText="No people found."
        loadMoreLabel="Load more people"
        describeError={describePeopleError}
        onSelect={onSelect}
        renderItem={(person) => (
          <>
            <span className="block font-medium text-slate-950">{displayName(person)}</span>
            {person.personalEmail && (
              <span className="block text-slate-600">{person.personalEmail}</span>
            )}
          </>
        )}
      />
    </div>
  );
}

const describePeopleError = (cause: unknown) =>
  employeeActionErrorMessage(cause, 'Unable to load people.');

function AssignmentFields({
  assignment,
  onChange,
}: {
  assignment: AssignmentFormState;
  onChange<K extends keyof AssignmentFormState>(field: K, value: AssignmentFormState[K]): void;
}) {
  return (
    <div className="mt-5 space-y-5">
      <EmployeePositionPicker
        selected={assignment.position}
        onSelect={(position) => onChange('position', position)}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          Employment type
          <select
            value={assignment.employmentType}
            onChange={(event) =>
              onChange('employmentType', event.target.value as EmploymentType | '')
            }
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">Select employment type</option>
            {employmentTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Start date
          <input
            type="date"
            value={assignment.startDate}
            onChange={(event) => onChange('startDate', event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          End date
          <input
            type="date"
            value={assignment.endDate}
            onChange={(event) => onChange('endDate', event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={assignment.primary}
            onChange={(event) => onChange('primary', event.currentTarget.checked)}
            className={checkboxClass}
          />
          Primary assignment
        </label>
      </div>
    </div>
  );
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function personPayload(person: PersonFormState): EmployeePersonInput {
  return {
    firstName: person.firstName.trim(),
    lastName: person.lastName.trim(),
    ...(optionalText(person.middleName) ? { middleName: optionalText(person.middleName) } : {}),
    ...(optionalText(person.preferredName)
      ? { preferredName: optionalText(person.preferredName) }
      : {}),
    ...(optionalText(person.personalEmail)
      ? { personalEmail: optionalText(person.personalEmail) }
      : {}),
    ...(optionalText(person.phone) ? { phone: optionalText(person.phone) } : {}),
  };
}

function validateForm({
  systemManage,
  personMode,
  person,
  selectedPerson,
  hireDate,
  assignmentEnabled,
  assignment,
}: {
  systemManage: boolean;
  personMode: PersonMode;
  person: PersonFormState;
  selectedPerson: EmployeePersonOption | null;
  hireDate: string;
  assignmentEnabled: boolean;
  assignment: AssignmentFormState;
}): string | null {
  if (!systemManage && personMode !== 'new') return 'Scoped managers must create a new person.';
  if (personMode === 'new' && !person.firstName.trim()) return 'First name is required.';
  if (personMode === 'new' && !person.lastName.trim()) return 'Last name is required.';
  if (personMode === 'existing' && !selectedPerson) return 'Select an existing person.';
  if (!hireDate) return 'Hire date is required.';
  if (assignmentEnabled) {
    if (!assignment.position) return 'Position is required for the initial assignment.';
    if (!assignment.employmentType)
      return 'Employment type is required for the initial assignment.';
    if (!assignment.startDate) return 'Start date is required for the initial assignment.';
    if (assignment.endDate && assignment.endDate < assignment.startDate)
      return 'End date must be on or after start date.';
  }
  return null;
}

function buildCreatePayload({
  personMode,
  person,
  selectedPerson,
  employeeNumber,
  hireDate,
  assignmentEnabled,
  assignment,
}: {
  personMode: PersonMode;
  person: PersonFormState;
  selectedPerson: EmployeePersonOption | null;
  employeeNumber: string;
  hireDate: string;
  assignmentEnabled: boolean;
  assignment: AssignmentFormState;
}): EmployeeCreateInput {
  const payload: EmployeeCreateInput =
    personMode === 'existing'
      ? { personId: selectedPerson!.id, hireDate }
      : { person: personPayload(person), hireDate };
  const normalizedEmployeeNumber = optionalText(employeeNumber);
  if (normalizedEmployeeNumber) payload.employeeNumber = normalizedEmployeeNumber;
  if (assignmentEnabled && assignment.position) {
    payload.initialPositionId = assignment.position.id;
    payload.initialEmploymentType = assignment.employmentType || undefined;
    payload.initialStartDate = assignment.startDate;
    if (assignment.endDate) payload.initialEndDate = assignment.endDate;
    payload.initialPrimary = assignment.primary;
  }
  return payload;
}
