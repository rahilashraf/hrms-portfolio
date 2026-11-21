'use client';

import { checkboxClass } from '../../ui/tokens';
import { useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import type {
  Competency,
  ItemType,
  RatingScale,
  Respondent,
  ScoringMode,
  TemplateDetail,
  TemplateItemInput,
} from '../../../lib/performance/types';
import { FormDialog } from '../../ui/form-dialog';
import { useConfirm } from '../../ui/use-confirm';
import {
  EmptyState,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../performance-shared';
import { CODE_PATTERN, Field, SectionState, useSectionData, type SectionProps } from './shared';
import { DataTable } from '../../ui/data-table';

const ITEM_TYPES: ItemType[] = [
  'RATING',
  'SCALE',
  'TEXT',
  'YES_NO',
  'GOAL_PROGRESS',
  'EVIDENCE_REFERENCE',
];
const RESPONDENTS: Respondent[] = ['BOTH', 'REVIEWER', 'SELF'];

export interface DraftSection {
  title: string;
  items: TemplateItemInput[];
}

const blankItem = (): TemplateItemInput => ({ itemType: 'TEXT', prompt: '', respondent: 'BOTH' });

/** The API form of the draft content (fields an item type does not use are cleared). */
export function sectionsInput(
  sections: DraftSection[],
  scoringMode: ScoringMode,
  scaleId: string | null,
) {
  return sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({
      itemType: item.itemType,
      prompt: item.prompt,
      helpText: item.helpText ?? null,
      respondent: item.respondent,
      required: item.required ?? false,
      weight:
        scoringMode === 'WEIGHTED_AVERAGE' &&
        item.itemType === 'RATING' &&
        item.respondent !== 'SELF'
          ? item.weight || null
          : null,
      competencyId: item.itemType === 'RATING' ? item.competencyId || null : null,
      ratingScaleId: item.itemType === 'RATING' ? scaleId : null,
      scaleMin: item.itemType === 'SCALE' ? (item.scaleMin ?? 1) : null,
      scaleMax: item.itemType === 'SCALE' ? (item.scaleMax ?? 10) : null,
    })),
  }));
}

/** A template detail's content as editable draft sections. */
function draftOf(template: TemplateDetail): DraftSection[] {
  return template.sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({
      itemType: item.itemType,
      prompt: item.prompt,
      helpText: item.helpText ?? null,
      respondent: item.respondent,
      required: item.required ?? false,
      weight: item.weight ?? null,
      competencyId: item.competency?.id ?? null,
      scaleMin: item.scaleMin ?? null,
      scaleMax: item.scaleMax ?? null,
    })),
  }));
}

const SCALE_NOTE =
  'A draft scale can be chosen while building; activating the template needs every scale it uses to be active.';

export function TemplatesTab({
  organizationId,
  busy,
  mutate,
  version,
  canManage,
}: SectionProps & { canManage: boolean }) {
  const { data, error, loading, reload } = useSectionData(async () => {
    const [templates, scales, competencies] = await Promise.all([
      performanceApi.templates(organizationId),
      performanceApi.scales(organizationId),
      performanceApi.competencies(organizationId),
    ]);
    return {
      templates: templates.items,
      scales: scales.items.filter((s) => s.status !== 'ARCHIVED'),
      competencies: competencies.items.filter((c) => !c.archived),
    };
  }, [organizationId, version]);
  const [selected, setSelected] = useState<string | null>(null);
  const [copying, setCopying] = useState<{ id: string; code: string; name: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const templates = data?.templates ?? [];
  return (
    <div className="space-y-4">
      {confirmDialog}
      <SectionState loading={loading} error={error} onRetry={reload} what="templates">
        {templates.length === 0 ? (
          <EmptyState>No templates yet.</EmptyState>
        ) : (
          <DataTable
            label="Templates"
            rows={templates}
            rowKey={(template) => template.id}
            columns={[
              {
                key: 'template',
                header: 'Template',
                rowHeader: true,
                cell: (template) => (
                  <>
                    {template.name}
                    <span className="block text-xs font-normal text-slate-500">
                      {template.code}
                    </span>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (template) => <>{label(template.status)}</>,
              },
              {
                key: 'scoring',
                header: 'Scoring',
                cell: (template) => (
                  <>{template.scoringMode === 'NONE' ? 'Not scored' : 'Weighted average'}</>
                ),
              },
              {
                key: 'items',
                header: 'Items',
                cell: (template) => <>{template.itemCount}</>,
              },
              {
                key: 'cycles',
                header: 'Cycles',
                cell: (template) => <>{template.cycleCount}</>,
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                className: 'space-x-1 space-y-1',
                cell: (template) => (
                  <>
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={`Show ${template.name}`}
                      aria-expanded={selected === template.id}
                      onClick={() => setSelected(selected === template.id ? null : template.id)}
                    >
                      {selected === template.id ? 'Hide' : 'Details'}
                    </button>
                    {canManage && template.status === 'DRAFT' && (
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={busy}
                        aria-label={`Activate ${template.name}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Activate ${template.name}?`,
                              description:
                                'An active template can be used by review cycles and its content never changes again (copy it into a new version to change it). Every rating scale it uses must be active.',
                              confirmLabel: 'Activate template',
                              destructive: false,
                            })
                          )
                            void mutate(
                              () => performanceApi.transitionTemplate(template.id, 'activate'),
                              'Template activated.',
                            );
                        }}
                      >
                        Activate
                      </button>
                    )}
                    {canManage && template.status !== 'DRAFT' && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`New version of ${template.name}`}
                        onClick={() =>
                          setCopying({ id: template.id, code: template.code, name: template.name })
                        }
                      >
                        New version
                      </button>
                    )}
                    {canManage && template.status !== 'ARCHIVED' && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Archive ${template.name}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Archive ${template.name}?`,
                              description:
                                'New cycles can no longer use it. Cycles that already use it keep their frozen copy.',
                              confirmLabel: 'Archive template',
                            })
                          )
                            void mutate(
                              () => performanceApi.transitionTemplate(template.id, 'archive'),
                              'Template archived.',
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
        {selected && data && (
          <TemplateDetailPanel
            key={selected}
            templateId={selected}
            version={version}
            canManage={canManage}
            busy={busy}
            mutate={mutate}
            scales={data.scales}
            competencies={data.competencies}
          />
        )}
      </SectionState>
      {copying && (
        <CopyTemplateDialog
          source={copying}
          busy={busy}
          mutate={mutate}
          onClose={() => setCopying(null)}
        />
      )}
      {canManage && data && (
        <CreateTemplateForm
          organizationId={organizationId}
          scales={data.scales}
          competencies={data.competencies}
          busy={busy}
          mutate={mutate}
        />
      )}
    </div>
  );
}

function TemplateDetailPanel({
  templateId,
  version,
  canManage,
  busy,
  mutate,
  scales,
  competencies,
}: {
  templateId: string;
  version: number;
  canManage: boolean;
  busy: boolean;
  mutate: SectionProps['mutate'];
  scales: RatingScale[];
  competencies: Competency[];
}) {
  const { data, error, loading, reload } = useSectionData(
    () => performanceApi.template(templateId),
    [templateId, version],
  );
  const [editing, setEditing] = useState(false);
  return (
    <section
      aria-label={data ? `Details of ${data.name}` : 'Template details'}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <SectionState loading={loading} error={error} onRetry={reload} what="the template">
        {data && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {data.name} <span className="text-sm text-slate-500">({data.code})</span>
                </h2>
                {data.description && <p className="text-sm text-slate-600">{data.description}</p>}
                <p className="text-sm text-slate-700">
                  {label(data.status)} ·{' '}
                  {data.scoringMode === 'NONE' ? 'Not scored' : 'Weighted average'} · Scale:{' '}
                  {data.ratingScale
                    ? `${data.ratingScale.name} (${label(data.ratingScale.status)})`
                    : '—'}
                </p>
                {data.status === 'DRAFT' && data.ratingScale?.status === 'DRAFT' && (
                  <p className="text-sm text-amber-800">
                    Its rating scale is a draft: activate the scale before the template.
                  </p>
                )}
              </div>
              {canManage && data.actions.canEdit && (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Edit template
                </button>
              )}
            </div>
            {data.sections.map((section) => (
              <div key={section.id} className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-900">{section.title}</h3>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-800">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      {item.prompt}{' '}
                      <span className="text-xs text-slate-500">
                        ({label(item.itemType)} ·{' '}
                        {item.respondent === 'BOTH'
                          ? 'Employee and reviewer'
                          : label(item.respondent)}
                        {item.required ? ' · required' : ''}
                        {item.weight ? ` · weight ${item.weight}%` : ''}
                        {item.competency ? ` · ${item.competency.name}` : ''})
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {editing && (
              <EditTemplateDialog
                template={data}
                scales={scales}
                competencies={competencies}
                busy={busy}
                mutate={mutate}
                onClose={() => setEditing(false)}
              />
            )}
          </>
        )}
      </SectionState>
    </section>
  );
}

/** Explicit code (and name) for a new draft version: never generated. */
function CopyTemplateDialog({
  source,
  busy,
  mutate,
  onClose,
}: {
  source: { id: string; code: string; name: string };
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(source.name);
  const [error, setError] = useState<string | null>(null);
  const codeValid = CODE_PATTERN.test(code.trim());
  const codeError =
    code.trim() !== '' && !codeValid
      ? '2 to 64 letters, digits, “_” or “-” (stored in upper case).'
      : code.trim().toUpperCase() === source.code
        ? 'The new version needs its own code.'
        : null;
  return (
    <FormDialog
      open
      title={`New version of ${source.name}`}
      description="The content is copied into a new draft template; the current one stays as it is."
      submitLabel="Create draft version"
      busy={busy}
      canSubmit={codeValid && !codeError && name.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const ok = await mutate(
          () => performanceApi.copyTemplate(source.id, code.trim().toUpperCase(), name.trim()),
          'New draft version created.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <Field label="New code" hint={`For example ${source.code}-V2.`}>
          <input
            className={inputClass}
            required
            value={code}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? 'copy-code-error' : undefined}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
        </Field>
        {codeError && (
          <p id="copy-code-error" className="text-sm text-rose-800">
            {codeError}
          </p>
        )}
        <Field label="New name">
          <input
            className={inputClass}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function EditTemplateDialog({
  template,
  scales,
  competencies,
  busy,
  mutate,
  onClose,
}: {
  template: TemplateDetail;
  scales: RatingScale[];
  competencies: Competency[];
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const draft = template.status === 'DRAFT';
  const [header, setHeader] = useState({
    name: template.name,
    description: template.description ?? '',
    scoringMode: template.scoringMode,
    ratingScaleId: template.ratingScale?.id ?? scales[0]?.id ?? '',
    overallRatingEnabled: template.overallRatingEnabled,
  });
  const [sections, setSections] = useState<DraftSection[]>(() => draftOf(template));
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      size="lg"
      title={`Edit ${template.name}`}
      description={
        draft
          ? 'A draft template can change its content; it is saved whole.'
          : 'An active template keeps its content (copy it into a new version to change it); its name and description can change.'
      }
      submitLabel="Save template"
      busy={busy}
      canSubmit={header.name.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const scaleId = header.ratingScaleId || null;
        const ok = await mutate(
          () =>
            performanceApi.updateTemplate(template.id, {
              name: header.name.trim(),
              description: header.description.trim() || null,
              ...(draft
                ? {
                    scoringMode: header.scoringMode,
                    ratingScaleId: scaleId,
                    overallRatingEnabled: header.overallRatingEnabled,
                    sections: sectionsInput(sections, header.scoringMode, scaleId),
                  }
                : {}),
            }),
          'Template saved.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Template name">
            <input
              className={inputClass}
              required
              value={header.name}
              onChange={(e) => setHeader({ ...header, name: e.currentTarget.value })}
            />
          </Field>
          <Field label="Description">
            <input
              className={inputClass}
              value={header.description}
              onChange={(e) => setHeader({ ...header, description: e.currentTarget.value })}
            />
          </Field>
        </div>
        {draft && (
          <TemplateContentEditor
            header={header}
            onHeader={(patch) => setHeader((current) => ({ ...current, ...patch }))}
            sections={sections}
            onSections={setSections}
            scales={scales}
            competencies={competencies}
          />
        )}
      </div>
    </FormDialog>
  );
}

/** Scoring, scale, overall rating and sections/items with add and remove. */
function TemplateContentEditor({
  header,
  onHeader,
  sections,
  onSections,
  scales,
  competencies,
}: {
  header: { scoringMode: ScoringMode; ratingScaleId: string; overallRatingEnabled: boolean };
  onHeader(
    patch: Partial<{
      scoringMode: ScoringMode;
      ratingScaleId: string;
      overallRatingEnabled: boolean;
    }>,
  ): void;
  sections: DraftSection[];
  onSections(update: (current: DraftSection[]) => DraftSection[]): void;
  scales: RatingScale[];
  competencies: Competency[];
}) {
  const updateItem = (s: number, i: number, patch: Partial<TemplateItemInput>) =>
    onSections((current) =>
      current.map((section, si) =>
        si !== s
          ? section
          : {
              ...section,
              items: section.items.map((item, ii) => (ii === i ? { ...item, ...patch } : item)),
            },
      ),
    );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Scoring">
          <select
            className={inputClass}
            value={header.scoringMode}
            onChange={(e) => onHeader({ scoringMode: e.currentTarget.value as ScoringMode })}
          >
            <option value="NONE">Not scored</option>
            <option value="WEIGHTED_AVERAGE">Weighted average (weights total 100)</option>
          </select>
        </Field>
        <Field label="Rating scale" hint={SCALE_NOTE}>
          <select
            className={inputClass}
            value={header.ratingScaleId}
            onChange={(e) => onHeader({ ratingScaleId: e.currentTarget.value })}
          >
            {scales.length === 0 && <option value="">No rating scale yet</option>}
            {scales.map((scale) => (
              <option key={scale.id} value={scale.id}>
                {scale.name} ({label(scale.status)})
              </option>
            ))}
          </select>
        </Field>
        <label className="inline-flex items-end gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={header.overallRatingEnabled}
            onChange={(e) => onHeader({ overallRatingEnabled: e.currentTarget.checked })}
          />
          Overall rating
        </label>
      </div>
      {sections.map((section, s) => (
        <fieldset key={s} className="space-y-2 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium">Section {s + 1}</legend>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="Section title">
                <input
                  className={inputClass}
                  required
                  value={section.title}
                  onChange={(e) => {
                    const title = e.currentTarget.value;
                    onSections((current) =>
                      current.map((row, si) => (si === s ? { ...row, title } : row)),
                    );
                  }}
                />
              </Field>
            </div>
            {sections.length > 1 && (
              <button
                type="button"
                className={secondaryButton}
                aria-label={`Remove section ${s + 1}`}
                onClick={() => onSections((current) => current.filter((_, si) => si !== s))}
              >
                Remove section
              </button>
            )}
          </div>
          {section.items.map((item, i) => (
            <div
              key={i}
              role="group"
              aria-label={`Section ${s + 1}, item ${i + 1}`}
              className="grid grid-cols-1 gap-2 border-t border-slate-100 pt-2 sm:grid-cols-6"
            >
              <Field label="Item type">
                <select
                  className={inputClass}
                  value={item.itemType}
                  onChange={(e) =>
                    updateItem(s, i, { itemType: e.currentTarget.value as ItemType })
                  }
                >
                  {ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {label(type)}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Prompt">
                  <input
                    className={inputClass}
                    required
                    value={item.prompt}
                    onChange={(e) => updateItem(s, i, { prompt: e.currentTarget.value })}
                  />
                </Field>
              </div>
              <Field label="Answered by">
                <select
                  className={inputClass}
                  value={item.respondent}
                  onChange={(e) =>
                    updateItem(s, i, { respondent: e.currentTarget.value as Respondent })
                  }
                >
                  {RESPONDENTS.map((respondent) => (
                    <option key={respondent} value={respondent}>
                      {respondent === 'BOTH' ? 'Employee and reviewer' : label(respondent)}
                    </option>
                  ))}
                </select>
              </Field>
              {item.itemType === 'RATING' && (
                <Field label="Competency">
                  <select
                    className={inputClass}
                    value={item.competencyId ?? ''}
                    onChange={(e) =>
                      updateItem(s, i, { competencyId: e.currentTarget.value || null })
                    }
                  >
                    <option value="">None</option>
                    {competencies.map((competency) => (
                      <option key={competency.id} value={competency.id}>
                        {competency.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {header.scoringMode === 'WEIGHTED_AVERAGE' &&
                item.itemType === 'RATING' &&
                item.respondent !== 'SELF' && (
                  <Field label="Weight %">
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      value={item.weight ?? ''}
                      onChange={(e) => updateItem(s, i, { weight: e.currentTarget.value })}
                    />
                  </Field>
                )}
              <div className="flex flex-wrap items-end gap-2">
                <label className="inline-flex items-center gap-1 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={item.required ?? false}
                    onChange={(e) => updateItem(s, i, { required: e.currentTarget.checked })}
                  />
                  Required
                </label>
                {section.items.length > 1 && (
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={`Remove item ${i + 1} of section ${s + 1}`}
                    onClick={() =>
                      onSections((current) =>
                        current.map((row, si) =>
                          si === s ? { ...row, items: row.items.filter((_, ii) => ii !== i) } : row,
                        ),
                      )
                    }
                  >
                    Remove item
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            className={secondaryButton}
            onClick={() =>
              onSections((current) =>
                current.map((row, si) =>
                  si === s ? { ...row, items: [...row.items, blankItem()] } : row,
                ),
              )
            }
          >
            Add item
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className={secondaryButton}
        onClick={() => onSections((current) => [...current, { title: '', items: [blankItem()] }])}
      >
        Add section
      </button>
    </div>
  );
}

function CreateTemplateForm({
  organizationId,
  scales,
  competencies,
  busy,
  mutate,
}: {
  organizationId: string;
  scales: RatingScale[];
  competencies: Competency[];
  busy: boolean;
  mutate: SectionProps['mutate'];
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [header, setHeader] = useState({
    scoringMode: 'NONE' as ScoringMode,
    ratingScaleId: '',
    overallRatingEnabled: true,
  });
  const [sections, setSections] = useState<DraftSection[]>([
    {
      title: 'Competencies',
      items: [{ itemType: 'RATING', prompt: '', respondent: 'BOTH', required: true }],
    },
  ]);
  const codeInvalid = code.trim() !== '' && !CODE_PATTERN.test(code.trim());
  return (
    <form
      aria-label="Create template"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (codeInvalid) return;
        const scaleId = header.ratingScaleId || scales[0]?.id || null;
        const ok = await mutate(
          () =>
            performanceApi.createTemplate({
              organizationId,
              code: code.trim(),
              name: name.trim(),
              scoringMode: header.scoringMode,
              ratingScaleId: scaleId,
              overallRatingEnabled: header.overallRatingEnabled,
              sections: sectionsInput(sections, header.scoringMode, scaleId),
            }),
          'Template created as a draft.',
        );
        if (ok) {
          setCode('');
          setName('');
        }
      }}
    >
      <h2 className="text-base font-semibold text-slate-900">New template</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Code" hint="2 to 64 letters, digits, “_” or “-”.">
          <input
            className={inputClass}
            required
            value={code}
            aria-invalid={codeInvalid ? true : undefined}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
        </Field>
        <Field label="Name">
          <input
            className={inputClass}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
      </div>
      <TemplateContentEditor
        header={header}
        onHeader={(patch) => setHeader((current) => ({ ...current, ...patch }))}
        sections={sections}
        onSections={setSections}
        scales={scales}
        competencies={competencies}
      />
      <button
        type="submit"
        className={primaryButton}
        disabled={busy || scales.length === 0 || codeInvalid}
      >
        Create template
      </button>
    </form>
  );
}
