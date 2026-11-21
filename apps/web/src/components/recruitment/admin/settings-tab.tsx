'use client';

import { useCallback, useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import type { Stage, StageKind } from '../../../lib/recruitment/types';
import {
  EmptyState,
  Field,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../recruitment-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { Loading, Mutate, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: hiring stages (moved from recruitment-admin-page.tsx unchanged).
const STAGE_KINDS: StageKind[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'ASSESSMENT',
  'REFERENCE_CHECK',
  'OFFER',
  'OTHER',
];

export function SettingsTab({
  organizationId,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(() => recruitmentApi.stages(organizationId), [organizationId]);
  const { data, loaded } = useData(load, onError);
  const [names, setNames] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ code: '', name: '', kind: 'OTHER' as StageKind });
  if (!loaded) return <Loading />;
  const stages: Stage[] = data?.items ?? [];
  const move = (index: number, delta: number) => {
    const ids = stages.map((stage) => stage.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    void mutate(() => recruitmentApi.reorderStages(organizationId, ids), 'Stages reordered.');
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Hiring stages</h2>
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() =>
            void mutate(
              () => recruitmentApi.initializeStages(organizationId),
              'Default stages initialized.',
            )
          }
        >
          Initialize default stages
        </button>
      </div>
      {stages.length === 0 ? (
        <EmptyState>No hiring stages yet. Initialize the defaults to start.</EmptyState>
      ) : (
        <DataTable
          label="Hiring stages"
          rows={stages}
          rowKey={(stage) => stage.id}
          columns={[
            {
              key: 'order',
              header: 'Order',
              cell: (stage, index) => <>{index + 1}</>,
            },
            {
              key: 'stage',
              header: 'Stage',
              rowHeader: true,
              cell: (stage) => (
                <>
                  {stage.name}
                  <span className="block text-xs font-normal text-slate-500">{stage.code}</span>
                </>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              cell: (stage) => <>{label(stage.kind)}</>,
            },
            {
              key: 'rename',
              header: 'Rename',
              className: 'whitespace-nowrap',
              cell: (stage) => (
                <>
                  <label className="relative text-xs text-slate-600">
                    <span className="sr-only">New name for {stage.name}</span>
                    <input
                      className="w-40 rounded border border-slate-300 px-2 py-1"
                      value={names[stage.id] ?? ''}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setNames((current) => ({ ...current, [stage.id]: value }));
                      }}
                    />
                  </label>{' '}
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || !names[stage.id]?.trim()}
                    aria-label={`Rename ${stage.name}`}
                    onClick={() =>
                      void mutate(
                        () =>
                          recruitmentApi.updateStage(stage.id, { name: names[stage.id]!.trim() }),
                        'Stage renamed.',
                      )
                    }
                  >
                    Rename
                  </button>
                </>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              className: 'space-x-1 whitespace-nowrap',
              cell: (stage, index) => (
                <>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || index === 0}
                    aria-label={`Move ${stage.name} up`}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || index === stages.length - 1}
                    aria-label={`Move ${stage.name} down`}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  {stage.kind !== 'HIRED' && (
                    <ConfirmButton
                      className={secondaryButton}
                      disabled={busy}
                      aria-label={`Archive ${stage.name}`}
                      confirm={{
                        title: `Archive ${stage.name}?`,
                        description:
                          'The stage can no longer be used for applications. Applications that passed through it keep their history.',
                        confirmLabel: 'Archive stage',
                      }}
                      onConfirm={() =>
                        void mutate(() => recruitmentApi.archiveStage(stage.id), 'Stage archived.')
                      }
                    >
                      Archive
                    </ConfirmButton>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      <form
        aria-label="Add stage"
        className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            () =>
              recruitmentApi.createStage({
                organizationId,
                code: form.code.trim(),
                name: form.name.trim(),
                kind: form.kind,
              }),
            'Stage added.',
          );
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
        <Field label="Stage name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </Field>
        <Field label="Kind">
          <select
            className={inputClass}
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as StageKind })}
          >
            {STAGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {label(kind)}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end">
          <button type="submit" className={primaryButton} disabled={busy}>
            Add stage
          </button>
        </div>
      </form>
    </div>
  );
}
