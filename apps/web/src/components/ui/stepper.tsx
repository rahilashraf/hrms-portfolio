import type { ReactNode } from 'react';
import { Icon } from '../shell/icons';

export type StepState = 'complete' | 'current' | 'upcoming' | 'skipped';

export interface Step {
  key: string;
  label: string;
  description?: ReactNode;
  state: StepState;
}

/**
 * Builds stepper steps from an ordered lifecycle and the current state. A state outside the
 * path (e.g. VOIDED or CANCELLED) marks every unreached step as skipped.
 */
export function lifecycleSteps<S extends string>(
  path: ReadonlyArray<{ key: S; label: string; description?: ReactNode }>,
  current: S,
  options: { completeAtEnd?: boolean; reached?: S } = {},
): Step[] {
  const index = path.findIndex((step) => step.key === current);
  const reachedIndex = options.reached
    ? path.findIndex((step) => step.key === options.reached)
    : -1;
  return path.map((step, position) => {
    let state: StepState;
    if (index < 0) state = position <= reachedIndex ? 'complete' : 'skipped';
    else if (position < index) state = 'complete';
    else if (position === index)
      state = options.completeAtEnd && position === path.length - 1 ? 'complete' : 'current';
    else state = 'upcoming';
    return { ...step, state };
  });
}

const STATE_TEXT: Record<StepState, string> = {
  complete: 'completed',
  current: 'current step',
  upcoming: 'not started',
  skipped: 'skipped',
};

/** A horizontal (wrapping) stepper for a workflow's real lifecycle states. */
export function Stepper({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap items-start gap-x-2 gap-y-3">
        {steps.map((step, index) => (
          <li
            key={step.key}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className="flex min-w-0 items-center gap-2"
          >
            <span
              className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                step.state === 'complete'
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : step.state === 'current'
                    ? 'border-indigo-700 bg-indigo-700 text-white'
                    : step.state === 'skipped'
                      ? 'border-slate-300 bg-slate-100 text-slate-600 line-through'
                      : 'border-slate-300 bg-white text-slate-600'
              }`}
            >
              {step.state === 'complete' ? <Icon name="check" className="size-4" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span
                className={`block text-sm font-medium ${step.state === 'upcoming' || step.state === 'skipped' ? 'text-slate-500' : 'text-slate-900'}`}
              >
                {step.label}
                <span className="sr-only"> ({STATE_TEXT[step.state]})</span>
              </span>
              {step.description && (
                <span className="block text-xs text-slate-500">{step.description}</span>
              )}
            </span>
            {index < steps.length - 1 && (
              <span aria-hidden="true" className="mx-1 hidden h-px w-6 bg-slate-300 sm:block" />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export interface TimelineEvent {
  key: string;
  title: ReactNode;
  /** ISO timestamp or preformatted text. */
  when?: ReactNode;
  detail?: ReactNode;
  tone?: 'neutral' | 'success' | 'danger' | 'info';
}

/** A vertical history of events (approvals, status changes) from existing records. */
export function StatusTimeline({
  events,
  label,
  empty = 'No history yet.',
}: {
  events: readonly TimelineEvent[];
  label: string;
  empty?: string;
}) {
  if (events.length === 0) return <p className="text-sm text-slate-600">{empty}</p>;
  return (
    <ol aria-label={label} className="relative space-y-4 border-l border-slate-200 pl-5">
      {events.map((event) => (
        <li key={event.key} className="relative">
          <span
            aria-hidden="true"
            className={`absolute -left-[1.6rem] top-1 size-3 rounded-full border-2 border-white ${
              event.tone === 'success'
                ? 'bg-emerald-600'
                : event.tone === 'danger'
                  ? 'bg-rose-600'
                  : event.tone === 'info'
                    ? 'bg-indigo-600'
                    : 'bg-slate-400'
            }`}
          />
          <p className="text-sm font-medium text-slate-900">{event.title}</p>
          {event.when && <p className="text-xs text-slate-500">{event.when}</p>}
          {event.detail && <div className="mt-1 text-sm text-slate-600">{event.detail}</div>}
        </li>
      ))}
    </ol>
  );
}
