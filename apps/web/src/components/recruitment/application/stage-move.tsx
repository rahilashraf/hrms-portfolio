'use client';

import { useEffect, useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import { recruitmentErrorMessage } from '../../../lib/recruitment/errors';
import type { ApplicationDetail, Stage } from '../../../lib/recruitment/types';
import { Field, inputClass, primaryButton } from '../recruitment-shared';
import { Run } from './application-shared';

// Batch 10E-1: moved from application-page.tsx unchanged.
export function StageMove({
  application,
  busy,
  run,
  onError,
}: {
  application: ApplicationDetail;
  busy: boolean;
  run: Run;
  onError(message: string): void;
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [stageId, setStageId] = useState('');
  const [note, setNote] = useState('');
  const organizationId = application.organization.id;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      recruitmentApi
        .stages(organizationId)
        .then((result) => setStages(result.items))
        .catch((cause) => onError(recruitmentErrorMessage(cause, 'Unable to load the stages.')));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [organizationId, onError]);
  // Candidates enter the Hired stage only through hire conversion.
  const choices = stages.filter(
    (stage) => stage.kind !== 'HIRED' && stage.id !== application.stage.id,
  );
  return (
    <form
      aria-label="Move stage"
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => recruitmentApi.moveStage(application.id, stageId, note.trim() || null),
          'Stage changed.',
        );
      }}
    >
      <Field label="Move to stage">
        <select
          className={inputClass}
          value={stageId}
          onChange={(e) => setStageId(e.currentTarget.value)}
        >
          <option value="">Choose a stage</option>
          {choices.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note (optional)">
        <input
          className={inputClass}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
      </Field>
      <button type="submit" className={primaryButton} disabled={busy || !stageId}>
        Move
      </button>
    </form>
  );
}
