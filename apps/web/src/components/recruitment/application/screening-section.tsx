'use client';

import { useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import type { ApplicationDetail, ScreeningOutcome } from '../../../lib/recruitment/types';
import {
  EmptyState,
  Field,
  formatDateOnly,
  inputClass,
  label,
  primaryButton,
  Section,
  yesNo,
} from '../recruitment-shared';
import { Run } from './application-shared';

// Batch 10E-1: moved from application-page.tsx unchanged.
const OUTCOMES: ScreeningOutcome[] = ['PENDING', 'ADVANCE', 'HOLD', 'DO_NOT_ADVANCE'];
type Tri = '' | 'yes' | 'no';
const toTri = (value: boolean | null | undefined): Tri =>
  value === null || value === undefined ? '' : value ? 'yes' : 'no';
const fromTri = (value: Tri) => (value === '' ? null : value === 'yes');

export function ScreeningSection({
  application,
  busy,
  run,
}: {
  application: ApplicationDetail;
  busy: boolean;
  run: Run;
}) {
  const screening = application.screening ?? null;
  const [form, setForm] = useState({
    outcome: (screening?.outcome ?? 'PENDING') as ScreeningOutcome,
    meetsMinimumQualifications: toTri(screening?.meetsMinimumQualifications),
    workAuthorizationConfirmed: toTri(screening?.workAuthorizationConfirmed),
    requiredCertificationsHeld: toTri(screening?.requiredCertificationsHeld),
    availableFrom: screening?.availableFrom ?? '',
    notes: screening?.notes ?? '',
  });
  const questions = [
    ['meetsMinimumQualifications', 'Meets minimum qualifications'],
    ['workAuthorizationConfirmed', 'Work authorization confirmed'],
    ['requiredCertificationsHeld', 'Required certifications held'],
  ] as const;
  return (
    <Section title="Screening">
      <p className="text-xs text-slate-500">
        Structured human screening. Nothing is scored or ranked automatically.
      </p>
      {screening ? (
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">Outcome</dt>
            <dd>{label(screening.outcome)}</dd>
          </div>
          {questions.map(([key, text]) => (
            <div key={key}>
              <dt className="text-slate-500">{text}</dt>
              <dd>{yesNo(screening[key])}</dd>
            </div>
          ))}
          <div>
            <dt className="text-slate-500">Available from</dt>
            <dd>{formatDateOnly(screening.availableFrom)}</dd>
          </div>
          {screening.notes && (
            <div className="sm:col-span-3">
              <dt className="text-slate-500">Notes</dt>
              <dd className="whitespace-pre-wrap">{screening.notes}</dd>
            </div>
          )}
        </dl>
      ) : (
        <EmptyState>Not screened yet.</EmptyState>
      )}
      {application.actions.canScreen && (
        <form
          aria-label="Screening form"
          className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                recruitmentApi.recordScreening(application.id, {
                  outcome: form.outcome,
                  meetsMinimumQualifications: fromTri(form.meetsMinimumQualifications),
                  workAuthorizationConfirmed: fromTri(form.workAuthorizationConfirmed),
                  requiredCertificationsHeld: fromTri(form.requiredCertificationsHeld),
                  availableFrom: form.availableFrom || null,
                  notes: form.notes.trim() || null,
                }),
              'Screening recorded.',
            );
          }}
        >
          <Field label="Screening outcome">
            <select
              className={inputClass}
              value={form.outcome}
              onChange={(e) =>
                setForm({ ...form, outcome: e.currentTarget.value as ScreeningOutcome })
              }
            >
              {OUTCOMES.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {label(outcome)}
                </option>
              ))}
            </select>
          </Field>
          {questions.map(([key, text]) => (
            <Field key={key} label={text}>
              <select
                className={inputClass}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.currentTarget.value as Tri })}
              >
                <option value="">Not recorded</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Field>
          ))}
          <Field label="Available from">
            <input
              className={inputClass}
              type="date"
              value={form.availableFrom}
              onChange={(e) => setForm({ ...form, availableFrom: e.currentTarget.value })}
            />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Screening notes">
              <textarea
                className={inputClass}
                rows={3}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
              />
            </Field>
          </div>
          <div>
            <button type="submit" className={primaryButton} disabled={busy}>
              Save screening
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}
