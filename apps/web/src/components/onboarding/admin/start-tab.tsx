'use client';

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type {
  OffboardingPrefill,
  OnboardingPrefill,
} from '../../../lib/onboarding/offboarding-link';
import { onboardingApi } from '../../../lib/onboarding/api';
import { activeWorkflowId } from '../../../lib/onboarding/errors';
import type {
  OnboardingOrganization,
  Template,
  WorkflowDetail,
  StartFromHireResult,
  WorkflowKind,
} from '../../../lib/onboarding/types';
import { Field, inputClass, KIND_LABELS, primaryButton } from '../onboarding-shared';
import { HirePicker, WorkflowAssignmentPicker } from '../onboarding-pickers';
import { Mutate } from './admin-shared';
import { workflowLink } from './dashboard-tab';

// Batch 10E-1: starting onboarding and offboarding (moved from onboarding-admin-page.tsx
// unchanged).
function TemplateSelect({
  templates,
  kind,
  value,
  onChange,
}: {
  templates: Template[];
  kind: WorkflowKind;
  value: string;
  onChange(value: string): void;
}) {
  const options = templates.filter((t) => t.kind === kind && t.status === 'ACTIVE');
  return (
    <Field label="Template">
      <select
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">Organization default</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function StartTab({
  organizationId,
  actions,
  busy,
  mutate,
  prefill = null,
  onboardPrefill = null,
}: {
  organizationId: string;
  actions: OnboardingOrganization['actions'];
  busy: boolean;
  mutate: Mutate;
  prefill?: OffboardingPrefill | null;
  onboardPrefill?: OnboardingPrefill | null;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [started, setStarted] = useState<{ id: string; text: string } | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState({
    employmentAssignmentId: onboardPrefill?.employmentAssignmentId ?? '',
    templateId: '',
  });
  const [offboarding, setOffboarding] = useState({
    employmentAssignmentId: prefill?.employmentAssignmentId ?? '',
    plannedEndDate: prefill?.plannedEndDate ?? '',
    reason: '',
    templateId: prefill?.templateId ?? '',
  });
  // An offboarding already open for the prefilled employee: offer it instead of a second one.
  const [openOffboarding, setOpenOffboarding] = useState<string | null>(null);
  useEffect(() => {
    if (!prefill) return;
    let active = true;
    const timer = window.setTimeout(() => {
      onboardingApi
        .employeeWorkflows(prefill.employeeId)
        .then((result) => {
          if (!active) return;
          const open = result.items.find(
            (workflow) =>
              workflow.kind === 'OFFBOARDING' &&
              workflow.status === 'ACTIVE' &&
              (!prefill.employmentAssignmentId ||
                workflow.employmentAssignmentId === prefill.employmentAssignmentId),
          );
          setOpenOffboarding(open?.id ?? null);
        })
        .catch(() => {
          // Without workflow read access the API still refuses a duplicate when starting.
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [prefill]);
  const [hire, setHire] = useState({ hireId: '', templateId: '' });

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      onboardingApi
        .templates(organizationId)
        .then((result) => {
          if (active) setTemplates(result.items);
        })
        .catch(() => {
          // Without template access the organization default is used.
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId]);

  async function start(
    action: () => Promise<WorkflowDetail | StartFromHireResult>,
    message: string | ((result: WorkflowDetail | StartFromHireResult) => string),
  ) {
    setStarted(null);
    setExisting(null);
    let result: WorkflowDetail | StartFromHireResult | null = null;
    const ok = await mutate(
      async () => {
        try {
          result = await action();
        } catch (cause) {
          setExisting(activeWorkflowId(cause));
          throw cause;
        }
      },
      typeof message === 'string' ? message : '',
    );
    const detail = result as WorkflowDetail | StartFromHireResult | null;
    if (ok && detail) {
      const who = `${KIND_LABELS[detail.kind]} for ${detail.employee.displayName ?? 'the employee'}`;
      setStarted({
        id: detail.id,
        text: typeof message === 'string' ? who : `${message(detail)} — ${who}`,
      });
    }
  }

  const submit = (
    event: FormEvent,
    action: () => Promise<WorkflowDetail | StartFromHireResult>,
    message: string | ((result: WorkflowDetail | StartFromHireResult) => string),
  ) => {
    event.preventDefault();
    void start(action, message);
  };

  return (
    <div className="space-y-4">
      {started && (
        <p role="status" className="text-sm text-slate-800">
          {workflowLink(started.id, `Open ${started.text}`)}
        </p>
      )}
      {existing && (
        <p className="text-sm text-amber-800">
          {workflowLink(existing, 'Open the active workflow')}
        </p>
      )}
      {actions.onboarding && (
        <form
          aria-label="Start onboarding"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={(event) =>
            submit(
              event,
              () =>
                onboardingApi.startOnboarding({
                  employmentAssignmentId: onboarding.employmentAssignmentId.trim(),
                  templateId: onboarding.templateId || null,
                }),
              'Onboarding started.',
            )
          }
        >
          <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">Start onboarding</h2>
          {onboardPrefill && (
            <p
              role="note"
              className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950 sm:col-span-3"
            >
              Prefilled from the employee&apos;s profile. Nothing has started: review the details
              and start the workflow yourself.
            </p>
          )}
          <WorkflowAssignmentPicker
            organizationId={organizationId}
            kind="ONBOARDING"
            value={onboarding.employmentAssignmentId}
            prefillEmployeeId={onboardPrefill?.employeeId}
            onChange={(employmentAssignmentId) =>
              setOnboarding({ ...onboarding, employmentAssignmentId })
            }
          />
          <TemplateSelect
            templates={templates}
            kind="ONBOARDING"
            value={onboarding.templateId}
            onChange={(templateId) => setOnboarding({ ...onboarding, templateId })}
          />
          <div className="flex items-end">
            <button type="submit" className={primaryButton} disabled={busy}>
              Start onboarding
            </button>
          </div>
        </form>
      )}
      {actions.offboarding && (
        <form
          aria-label="Start offboarding"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={(event) =>
            submit(
              event,
              () =>
                onboardingApi.startOffboarding({
                  employmentAssignmentId: offboarding.employmentAssignmentId.trim(),
                  plannedEndDate: offboarding.plannedEndDate,
                  reason: offboarding.reason.trim() || null,
                  templateId: offboarding.templateId || null,
                }),
              'Offboarding started.',
            )
          }
        >
          <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
            Start offboarding
          </h2>
          <p className="text-sm text-slate-600 sm:col-span-3">
            Offboarding is a checklist only: it does not end the assignment or terminate the
            employee. Record the end in Core HR.
          </p>
          {prefill && (
            <p
              role="note"
              className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950 sm:col-span-3"
            >
              Prefilled from the employee&apos;s profile. Nothing has started: review the details
              and start the workflow yourself.
            </p>
          )}
          {openOffboarding && (
            <p
              role="alert"
              className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 sm:col-span-3"
            >
              An offboarding workflow is already open for this employee.{' '}
              {workflowLink(openOffboarding, 'Open the active workflow')}
            </p>
          )}
          <WorkflowAssignmentPicker
            organizationId={organizationId}
            kind="OFFBOARDING"
            value={offboarding.employmentAssignmentId}
            prefillEmployeeId={prefill?.employeeId}
            onChange={(employmentAssignmentId) =>
              setOffboarding({ ...offboarding, employmentAssignmentId })
            }
          />
          <Field label="Planned last day">
            <input
              className={inputClass}
              type="date"
              required
              value={offboarding.plannedEndDate}
              onChange={(e) =>
                setOffboarding({ ...offboarding, plannedEndDate: e.currentTarget.value })
              }
            />
          </Field>
          <TemplateSelect
            templates={templates}
            kind="OFFBOARDING"
            value={offboarding.templateId}
            onChange={(templateId) => setOffboarding({ ...offboarding, templateId })}
          />
          <div className="sm:col-span-3">
            <Field label="Reason (HR only)">
              <textarea
                className={inputClass}
                rows={2}
                value={offboarding.reason}
                onChange={(e) => setOffboarding({ ...offboarding, reason: e.currentTarget.value })}
              />
            </Field>
          </div>
          <div>
            <button type="submit" className={primaryButton} disabled={busy}>
              Start offboarding
            </button>
          </div>
        </form>
      )}
      {actions.onboarding && (
        <form
          aria-label="Start onboarding from a hire"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={(event) =>
            submit(
              event,
              () => onboardingApi.startFromHire(hire.hireId.trim(), hire.templateId || null),
              (result) => {
                const fromHire = result as StartFromHireResult;
                if (fromHire.restartedFromWorkflowId)
                  return 'Onboarding restarted (the earlier one was cancelled)';
                return fromHire.created === false
                  ? 'Onboarding was already started for this hire'
                  : 'Onboarding started from the hire';
              },
            )
          }
        >
          <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
            Start onboarding from a recruitment hire
          </h2>
          <HirePicker
            organizationId={organizationId}
            value={hire.hireId}
            onChange={(hireId) => setHire({ ...hire, hireId })}
          />
          <TemplateSelect
            templates={templates}
            kind="ONBOARDING"
            value={hire.templateId}
            onChange={(templateId) => setHire({ ...hire, templateId })}
          />
          <div className="flex items-end">
            <button type="submit" className={primaryButton} disabled={busy}>
              Start from hire
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
