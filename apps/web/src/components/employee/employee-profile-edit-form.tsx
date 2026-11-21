'use client';

import { useId, useState, type FormEvent } from 'react';
import { employeeApi } from '../../lib/employee/api';
import { employeeActionErrorMessage } from '../../lib/employee/errors';
import type { EmployeeProfile, EmployeeUpdateInput } from '../../lib/employee/types';
import { ErrorBanner } from '../organization/shared';
import { buttonClass } from '../ui/button';
import { inputClass } from '../ui/tokens';

const FIELDS = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: true },
  { key: 'middleName', label: 'Middle name', required: false },
  { key: 'preferredName', label: 'Preferred name', required: false },
  { key: 'personalEmail', label: 'Personal email', required: false },
  { key: 'phone', label: 'Phone', required: false },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];

/**
 * R4-A.2: what to send — only the fields that changed. An optional field emptied by the user is
 * sent as `null` (cleared); a legal name cannot be emptied once it has a value. Returns the
 * changes, or the fields that are wrongly empty.
 */
export function profileChanges(
  person: Record<FieldKey, string | null>,
  form: Record<FieldKey, string>,
): { input: EmployeeUpdateInput; cleared: string[]; missing: FieldKey[] } {
  const input: EmployeeUpdateInput = {};
  const cleared: string[] = [];
  const missing: FieldKey[] = [];
  for (const field of FIELDS) {
    const before = person[field.key] ?? '';
    const after = form[field.key].trim();
    if (after === before.trim()) continue;
    if (after) {
      input[field.key] = after;
    } else if (field.required) {
      missing.push(field.key);
    } else {
      input[field.key] = null;
      cleared.push(field.label);
    }
  }
  return { input, cleared, missing };
}

/**
 * Batch 10B: the profile's edit form, moved out of `employee-profile.tsx`. R4-A.2: only changed
 * fields are sent; emptying an optional field removes it (the profile then confirms which).
 */
export function EmployeeProfileEditForm({
  profile,
  onCancel,
  onSaved,
}: {
  profile: EmployeeProfile;
  onCancel(): void;
  /** Called after a successful save with a confirmation to show. */
  onSaved(message: string): Promise<void>;
}) {
  const [form, setForm] = useState<Record<FieldKey, string>>({
    firstName: profile.person.firstName ?? '',
    middleName: profile.person.middleName ?? '',
    lastName: profile.person.lastName ?? '',
    preferredName: profile.person.preferredName ?? '',
    personalEmail: profile.person.personalEmail ?? '',
    phone: profile.person.phone ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<FieldKey[]>([]);
  const baseId = useId();

  function setField(field: FieldKey, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const changes = profileChanges(
      {
        firstName: profile.person.firstName ?? null,
        middleName: profile.person.middleName ?? null,
        lastName: profile.person.lastName ?? null,
        preferredName: profile.person.preferredName ?? null,
        personalEmail: profile.person.personalEmail ?? null,
        phone: profile.person.phone ?? null,
      },
      form,
    );
    setMissing(changes.missing);
    if (changes.missing.length > 0) {
      setError('The legal first and last name cannot be removed.');
      document.getElementById(`${baseId}-${changes.missing[0]}`)?.focus();
      return;
    }
    if (Object.keys(changes.input).length === 0) {
      setError('Nothing changed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await employeeApi.update(profile.id, changes.input);
      await onSaved(
        changes.cleared.length > 0
          ? `Profile updated. Removed: ${changes.cleared.join(', ')}.`
          : 'Profile updated.',
      );
    } catch (cause) {
      setError(employeeActionErrorMessage(cause, 'Unable to update profile.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-950">Edit profile</h2>
      <form onSubmit={submit} className="mt-5 space-y-5">
        {error && (
          <div id={`${baseId}-error`}>
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        )}
        <p id={`${baseId}-hint`} className="text-sm text-slate-600">
          Empty an optional field to remove it. The legal first and last name are required.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => {
            const id = `${baseId}-${field.key}`;
            const invalid = missing.includes(field.key);
            return (
              <div key={field.key}>
                <label htmlFor={id} className="text-sm font-medium text-slate-700">
                  {field.label}
                </label>
                <input
                  id={id}
                  type={
                    field.key === 'personalEmail' ? 'email' : field.key === 'phone' ? 'tel' : 'text'
                  }
                  value={form[field.key]}
                  onChange={(event) => setField(field.key, event.target.value)}
                  aria-required={field.required || undefined}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? `${baseId}-error` : `${baseId}-hint`}
                  className={inputClass}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={buttonClass('secondary')}
          >
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            {busy ? 'Saving...' : 'Save profile'}
          </button>
        </div>
      </form>
    </section>
  );
}
