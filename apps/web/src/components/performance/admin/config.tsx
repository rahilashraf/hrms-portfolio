'use client';

import { useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import type { Competency, RatingScale, ScaleLevel } from '../../../lib/performance/types';
import { FormDialog } from '../../ui/form-dialog';
import { useConfirm } from '../../ui/use-confirm';
import {
  EmptyState,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../performance-shared';
import { Field, SectionState, useSectionData, type SectionProps } from './shared';
import { DataTable } from '../../ui/data-table';

type ManageProps = SectionProps & { canManage: boolean };

// ─── Competencies ───────────────────────────────────────────────────────────

export function CompetenciesTab({ organizationId, busy, mutate, version, canManage }: ManageProps) {
  const { data, error, loading, reload } = useSectionData(
    async () => (await performanceApi.competencies(organizationId)).items,
    [organizationId, version],
  );
  const [form, setForm] = useState({ code: '', name: '', category: '' });
  const [editing, setEditing] = useState<Competency | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const competencies = data ?? [];
  return (
    <div className="space-y-4">
      {confirmDialog}
      <SectionState loading={loading} error={error} onRetry={reload} what="competencies">
        {competencies.length === 0 ? (
          <EmptyState>No competencies yet.</EmptyState>
        ) : (
          <DataTable
            label="Competencies"
            rows={competencies}
            rowKey={(competency) => competency.id}
            columns={[
              {
                key: 'competency',
                header: 'Competency',
                rowHeader: true,
                cell: (competency) => (
                  <>
                    {competency.name}
                    <span className="block text-xs font-normal text-slate-500">
                      {competency.code}
                    </span>
                    {competency.description && (
                      <span className="block text-xs font-normal text-slate-600">
                        {competency.description}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'category',
                header: 'Category',
                cell: (competency) => <>{competency.category ?? '—'}</>,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (competency) => <>{competency.archived ? 'Archived' : 'Active'}</>,
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                className: 'space-x-1 space-y-1',
                cell: (competency) => (
                  <>
                    {canManage && !competency.archived && (
                      <>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Edit ${competency.name}`}
                          onClick={() => setEditing(competency)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Archive ${competency.name}`}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Archive ${competency.name}?`,
                                description:
                                  'It can no longer be added to templates. Reviews that already used it keep it. A competency used by an active template cannot be archived until that template is archived or replaced.',
                                confirmLabel: 'Archive competency',
                              })
                            )
                              void mutate(
                                () => performanceApi.archiveCompetency(competency.id),
                                'Competency archived.',
                              );
                          }}
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </SectionState>
      {editing && (
        <EditCompetencyDialog
          competency={editing}
          busy={busy}
          mutate={mutate}
          onClose={() => setEditing(null)}
        />
      )}
      {canManage && (
        <form
          aria-label="Add competency"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const ok = await mutate(
              () =>
                performanceApi.createCompetency({
                  organizationId,
                  code: form.code,
                  name: form.name,
                  category: form.category || null,
                }),
              'Competency added.',
            );
            if (ok) setForm({ code: '', name: '', category: '' });
          }}
        >
          <Field label="Code">
            <input
              className={inputClass}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
            />
          </Field>
          <Field label="Competency name">
            <input
              className={inputClass}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
            />
          </Field>
          <Field label="Category">
            <input
              className={inputClass}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.currentTarget.value })}
            />
          </Field>
          <div className="flex items-end">
            <button type="submit" className={primaryButton} disabled={busy}>
              Add competency
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EditCompetencyDialog({
  competency,
  busy,
  mutate,
  onClose,
}: {
  competency: Competency;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [form, setForm] = useState({
    name: competency.name,
    category: competency.category ?? '',
    description: competency.description ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Edit ${competency.name}`}
      description="Templates and reviews show the new name. The code never changes."
      submitLabel="Save competency"
      busy={busy}
      canSubmit={form.name.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const ok = await mutate(
          async () => {
            await performanceApi.updateCompetency(competency.id, {
              name: form.name.trim(),
              category: form.category.trim() || null,
              description: form.description.trim() || null,
            });
          },
          'Competency saved.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <Field label="Competency name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </Field>
        <Field label="Category">
          <input
            className={inputClass}
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.currentTarget.value })}
          />
        </Field>
        <Field label="Description">
          <textarea
            className={inputClass}
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.currentTarget.value })}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

// ─── Rating scales ──────────────────────────────────────────────────────────

const DEFAULT_LEVELS =
  '1 Needs Improvement\n2 Developing\n3 Meets Expectations\n4 Exceeds Expectations\n5 Exceptional';

/** "1 Meets" lines → levels (null when a line has no numeric value or label). */
export function parseLevels(text: string): ScaleLevel[] | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const levels = lines.map((line) => {
    const [value, ...rest] = line.split(/\s+/);
    return { value: Number(value), label: rest.join(' '), description: null };
  });
  if (levels.length < 2 || levels.some((l) => !Number.isInteger(l.value) || l.label === ''))
    return null;
  return levels;
}
const levelsText = (levels: ScaleLevel[]) =>
  levels.map((level) => `${level.value} ${level.label}`).join('\n');
const LEVELS_HINT = 'At least two lines, each a whole number and a label (e.g. “3 Meets”).';

export function ScalesTab({ organizationId, busy, mutate, version, canManage }: ManageProps) {
  const { data, error, loading, reload } = useSectionData(
    async () => (await performanceApi.scales(organizationId)).items,
    [organizationId, version],
  );
  const [form, setForm] = useState({ code: '', name: '', levels: DEFAULT_LEVELS });
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RatingScale | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const scales = data ?? [];
  return (
    <div className="space-y-4">
      {confirmDialog}
      <SectionState loading={loading} error={error} onRetry={reload} what="rating scales">
        {scales.length === 0 ? (
          <EmptyState>No rating scales yet.</EmptyState>
        ) : (
          <DataTable
            label="Rating scales"
            rows={scales}
            rowKey={(scale) => scale.id}
            columns={[
              {
                key: 'scale',
                header: 'Scale',
                rowHeader: true,
                cell: (scale) => (
                  <>
                    {scale.name}
                    <span className="block text-xs font-normal text-slate-500">{scale.code}</span>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (scale) => <>{label(scale.status)}</>,
              },
              {
                key: 'levels',
                header: 'Levels',
                cell: (scale) => (
                  <>{scale.levels.map((level) => `${level.value} ${level.label}`).join(' · ')}</>
                ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                className: 'space-x-1 space-y-1',
                cell: (scale) => (
                  <>
                    {canManage && scale.status !== 'ARCHIVED' && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Edit ${scale.name}`}
                        onClick={() => setEditing(scale)}
                      >
                        Edit
                      </button>
                    )}
                    {canManage && scale.status === 'DRAFT' && (
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={busy}
                        aria-label={`Activate ${scale.name}`}
                        onClick={() =>
                          void mutate(
                            () => performanceApi.transitionScale(scale.id, 'activate'),
                            'Rating scale activated.',
                          )
                        }
                      >
                        Activate
                      </button>
                    )}
                    {canManage && scale.status !== 'ARCHIVED' && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Archive ${scale.name}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Archive ${scale.name}?`,
                              description:
                                'It can no longer be used by templates. Reviews keep the ratings given with it. A scale used by an active template cannot be archived until that template is archived or replaced.',
                              confirmLabel: 'Archive scale',
                            })
                          )
                            void mutate(
                              () => performanceApi.transitionScale(scale.id, 'archive'),
                              'Rating scale archived.',
                            );
                        }}
                      >
                        Archive
                      </button>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </SectionState>
      {editing && (
        <EditScaleDialog
          scale={editing}
          busy={busy}
          mutate={mutate}
          onClose={() => setEditing(null)}
        />
      )}
      {canManage && (
        <form
          aria-label="Add rating scale"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const levels = parseLevels(form.levels);
            if (!levels) {
              setFormError(LEVELS_HINT);
              return;
            }
            setFormError(null);
            const ok = await mutate(
              () =>
                performanceApi.createScale({
                  organizationId,
                  code: form.code,
                  name: form.name,
                  levels,
                }),
              'Rating scale added as a draft.',
            );
            if (ok) setForm({ code: '', name: '', levels: DEFAULT_LEVELS });
          }}
        >
          <Field label="Code">
            <input
              className={inputClass}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
            />
          </Field>
          <Field label="Scale name">
            <input
              className={inputClass}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
            />
          </Field>
          <Field label="Levels (one per line: value label)" hint={LEVELS_HINT}>
            <textarea
              className={inputClass}
              rows={5}
              value={form.levels}
              aria-invalid={formError ? true : undefined}
              onChange={(e) => setForm({ ...form, levels: e.currentTarget.value })}
            />
          </Field>
          {formError && (
            <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
              {formError}
            </p>
          )}
          <div>
            <button type="submit" className={primaryButton} disabled={busy}>
              Add scale
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EditScaleDialog({
  scale,
  busy,
  mutate,
  onClose,
}: {
  scale: RatingScale;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const draft = scale.status === 'DRAFT';
  const [form, setForm] = useState({
    name: scale.name,
    description: scale.description ?? '',
    levels: levelsText(scale.levels),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Edit ${scale.name}`}
      description={
        draft
          ? 'A draft scale can change its levels.'
          : 'The levels of an active scale never change (reviews were rated with them); create a new scale instead.'
      }
      submitLabel="Save scale"
      busy={busy}
      canSubmit={form.name.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const levels = draft ? parseLevels(form.levels) : undefined;
        if (levels === null) {
          setError(LEVELS_HINT);
          return;
        }
        const ok = await mutate(
          async () => {
            await performanceApi.updateScale(scale.id, {
              name: form.name.trim(),
              description: form.description.trim() || null,
              ...(levels ? { levels } : {}),
            });
          },
          'Rating scale saved.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <Field label="Scale name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </Field>
        <Field label="Description">
          <input
            className={inputClass}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.currentTarget.value })}
          />
        </Field>
        {draft ? (
          <Field label="Levels (one per line: value label)" hint={LEVELS_HINT}>
            <textarea
              className={inputClass}
              rows={5}
              value={form.levels}
              onChange={(e) => setForm({ ...form, levels: e.currentTarget.value })}
            />
          </Field>
        ) : (
          <p className="text-sm text-slate-700">
            Levels: {scale.levels.map((l) => `${l.value} ${l.label}`).join(' · ')}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
