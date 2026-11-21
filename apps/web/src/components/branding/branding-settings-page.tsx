'use client';

import { checkboxClass } from '../ui/tokens';

import { PageContainer } from '../ui/page-container';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  brandingApi,
  brandingErrorMessage,
  brandingInvalidField,
  isBrandingConflict,
} from '../../lib/branding/api';
import type { BrandingView } from '../../lib/branding/types';
import {
  BRANDING_LIMITS,
  brandingPayload,
  validateBranding,
  type BrandingErrors,
  type BrandingFormField,
  type BrandingFormValues,
} from '../../lib/branding/validation';
import { AuthApiError } from '../../lib/auth/types';
import { useWorkspace } from '../../providers/workspace-provider';
import { Forbidden } from '../auth/forbidden';
import { buttonClass } from '../ui/button';
import { PageHeader } from '../ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { useToast } from '../ui/toast';
import { BrandingPreview } from './branding-preview';

export const BRANDING_MANAGE = 'organization.branding.manage';

const EMPTY_VALUES: BrandingFormValues = {
  displayName: null,
  shortName: null,
  logoUrl: null,
  iconUrl: null,
  loginLogoUrl: null,
  primaryColor: null,
  secondaryColor: null,
  loginSubtitle: null,
  websiteUrl: null,
  supportEmail: null,
  publicLoginEnabled: false,
};

function valuesOf(view: BrandingView): BrandingFormValues {
  return {
    displayName: view.displayName,
    shortName: view.shortName,
    logoUrl: view.logoUrl,
    iconUrl: view.iconUrl,
    loginLogoUrl: view.loginLogoUrl,
    primaryColor: view.primaryColor,
    secondaryColor: view.secondaryColor,
    loginSubtitle: view.loginSubtitle,
    websiteUrl: view.websiteUrl,
    supportEmail: view.supportEmail,
    publicLoginEnabled: view.publicLoginEnabled,
  };
}

const inputClass =
  'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-[var(--hrms-accent-text)] disabled:bg-slate-100 disabled:text-slate-600 aria-[invalid=true]:border-rose-500';

/**
 * Phase 20 — Branding settings for the selected organization. Read-only unless the caller
 * holds organization.branding.manage there (the API decides; this only avoids dead controls).
 * Saving is optimistic-concurrency safe: a stale version (409) reloads the latest branding.
 */
export function BrandingSettingsPage() {
  const { selectedOrganization, navContext, status: workspaceStatus, refresh } = useWorkspace();
  const organizationId = selectedOrganization?.id ?? null;
  const canManage = Boolean(navContext?.permissions.has(BRANDING_MANAGE));

  const [view, setView] = useState<BrandingView | null>(null);
  const [values, setValues] = useState<BrandingFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<BrandingErrors>({});
  const [loadError, setLoadError] = useState<{ status: number | null; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async (id: string) => {
    const next = await brandingApi.get(id);
    setView(next);
    setValues(valuesOf(next));
    setErrors({});
    setLoadError(null);
    return next;
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setNotice(null);
      setSaveError(null);
      load(organizationId)
        .catch((cause) => {
          if (!active) return;
          setLoadError({
            status: cause instanceof AuthApiError ? cause.status : null,
            message: brandingErrorMessage(cause, 'Unable to load branding.'),
          });
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, load]);

  function update<K extends BrandingFormField>(field: K, value: BrandingFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !view || !canManage || saving) return;
    setNotice(null);
    setSaveError(null);
    const found = validateBranding(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setSaveError('Check the highlighted fields.');
      return;
    }
    setSaving(true);
    try {
      const saved = await brandingApi.update(organizationId, brandingPayload(values, view.version));
      setView(saved);
      setValues(valuesOf(saved));
      toast.success('Branding saved.');
      setNotice('Branding saved.');
      void refresh();
    } catch (cause) {
      if (isBrandingConflict(cause)) {
        try {
          await load(organizationId);
          setSaveError(
            'Someone else changed this branding while you were editing. The latest version has been loaded — review it and save again.',
          );
        } catch (reloadCause) {
          setSaveError(brandingErrorMessage(reloadCause, 'Unable to reload branding.'));
        }
      } else {
        const field = brandingInvalidField(cause);
        if (field && field in EMPTY_VALUES) {
          setErrors({ [field]: brandingErrorMessage(cause, 'This value is not accepted.') });
        }
        setSaveError(brandingErrorMessage(cause, 'Unable to save branding.'));
      }
    } finally {
      setSaving(false);
    }
  }

  const header = (
    <PageHeader
      eyebrow="Administration"
      title="Branding"
      description="Your organization's name, logo and colors in the app and on the sign-in page. Images are referenced by https address, never uploaded."
    />
  );

  if (workspaceStatus === 'loading') {
    return (
      <Page>
        {header}
        <div className="mt-6">
          <LoadingState label="Loading branding…" />
        </div>
      </Page>
    );
  }
  if (!selectedOrganization) {
    return (
      <Page>
        {header}
        <div className="mt-6">
          <EmptyState
            title="No organization selected"
            description="Branding belongs to an organization. Choose one in the organization switcher."
          />
        </div>
      </Page>
    );
  }
  if (loadError?.status === 403) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to view branding for this organization." />
      </PageContainer>
    );
  }

  const readOnly = !canManage;
  return (
    <Page>
      {header}
      {loading ? (
        <div className="mt-6">
          <LoadingState label="Loading branding…" />
        </div>
      ) : loadError ? (
        <div className="mt-6">
          <ErrorState
            message={loadError.message}
            onRetry={() => {
              setLoading(true);
              void load(selectedOrganization.id)
                .catch((cause) =>
                  setLoadError({
                    status: cause instanceof AuthApiError ? cause.status : null,
                    message: brandingErrorMessage(cause, 'Unable to load branding.'),
                  }),
                )
                .finally(() => setLoading(false));
            }}
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <form noValidate onSubmit={(event) => void submit(event)} className="space-y-6">
            {readOnly && (
              <p
                role="note"
                className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700"
              >
                You can view this organization&apos;s branding. Changing it needs the “Manage
                branding” permission.
              </p>
            )}
            {saveError && (
              <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
                {saveError}
              </p>
            )}
            {notice && (
              <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                {notice}
              </p>
            )}
            <fieldset disabled={readOnly || saving} className="space-y-6">
              <Section title="Names">
                <TextField
                  field="displayName"
                  label="Display name"
                  hint={`Shown in the app and on the sign-in page. Defaults to “${selectedOrganization.name}”.`}
                  max={BRANDING_LIMITS.displayName}
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <TextField
                  field="shortName"
                  label="Short name"
                  hint="Used where space is tight, such as the organization switcher and browser tab."
                  max={BRANDING_LIMITS.shortName}
                  values={values}
                  errors={errors}
                  onChange={update}
                />
              </Section>
              <Section
                title="Images"
                description="Absolute https:// addresses of images hosted elsewhere."
              >
                <TextField
                  field="logoUrl"
                  label="Logo URL"
                  type="url"
                  hint="Sidebar header."
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <TextField
                  field="iconUrl"
                  label="Icon URL"
                  type="url"
                  hint="Square icon for the collapsed sidebar and organization switcher."
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <TextField
                  field="loginLogoUrl"
                  label="Sign-in logo URL"
                  type="url"
                  hint="Shown on the sign-in page (falls back to the icon)."
                  values={values}
                  errors={errors}
                  onChange={update}
                />
              </Section>
              <Section
                title="Colors"
                description="Used for accents only when text on them stays readable (4.5:1 contrast)."
              >
                <ColorField
                  field="primaryColor"
                  label="Primary color"
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <ColorField
                  field="secondaryColor"
                  label="Secondary color"
                  values={values}
                  errors={errors}
                  onChange={update}
                />
              </Section>
              <Section title="Sign-in page">
                <TextField
                  field="loginSubtitle"
                  label="Sign-in subtitle"
                  max={BRANDING_LIMITS.loginSubtitle}
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <TextField
                  field="websiteUrl"
                  label="Website"
                  type="url"
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <TextField
                  field="supportEmail"
                  label="Support email"
                  type="email"
                  hint="Shown as a “Contact support” email link."
                  values={values}
                  errors={errors}
                  onChange={update}
                />
                <label className="flex items-start gap-3 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    className={`${checkboxClass} mt-1`}
                    checked={values.publicLoginEnabled}
                    onChange={(event) => update('publicLoginEnabled', event.currentTarget.checked)}
                    aria-describedby="public-login-help"
                  />
                  <span>
                    <span className="font-medium">Show this branding on the sign-in page</span>
                    <span id="public-login-help" className="mt-1 block text-slate-600">
                      Lets the sign-in page show this branding before anyone signs in (for example
                      with <code>?organization={selectedOrganization.code}</code>). Only
                      presentation fields are public: names, sign-in logo, icon, colors, subtitle,
                      website and support email.
                    </span>
                  </span>
                </label>
              </Section>
            </fieldset>
            {!readOnly && (
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" disabled={saving} className={buttonClass('primary')}>
                  {saving ? 'Saving…' : 'Save branding'}
                </button>
                <button
                  type="button"
                  disabled={saving || !view}
                  onClick={() => {
                    if (!view) return;
                    setValues(valuesOf(view));
                    setErrors({});
                    setSaveError(null);
                  }}
                  className={buttonClass('secondary')}
                >
                  Discard changes
                </button>
              </div>
            )}
          </form>
          <BrandingPreview values={values} organizationName={selectedOrganization.name} />
        </div>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <PageContainer width="wide">{children}</PageContainer>;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <div>
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {children}
    </section>
  );
}

type FieldProps = {
  values: BrandingFormValues;
  errors: BrandingErrors;
  onChange<K extends BrandingFormField>(field: K, value: BrandingFormValues[K]): void;
};

type TextFieldName = Exclude<BrandingFormField, 'publicLoginEnabled'>;

function TextField({
  field,
  label,
  hint,
  type = 'text',
  max,
  values,
  errors,
  onChange,
}: FieldProps & {
  field: TextFieldName;
  label: string;
  hint?: string;
  type?: 'text' | 'url' | 'email';
  max?: number;
}) {
  const id = useId();
  const error = errors[field];
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={values[field] ?? ''}
        maxLength={max ? max + 20 : undefined}
        placeholder={type === 'url' ? 'https://' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(field, event.currentTarget.value)}
        className={inputClass}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}

function ColorField({
  field,
  label,
  values,
  errors,
  onChange,
}: FieldProps & { field: 'primaryColor' | 'secondaryColor'; label: string }) {
  const id = useId();
  const error = errors[field];
  const value = values[field] ?? '';
  const valid = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label} (hex)
      </label>
      <div className="mt-1 flex items-center gap-3">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={valid ? value.toLowerCase() : '#4338ca'}
          onChange={(event) => onChange(field, event.currentTarget.value.toUpperCase())}
          className="h-10 w-14 shrink-0 cursor-pointer rounded border border-slate-300 bg-white p-1 disabled:cursor-not-allowed"
        />
        <input
          id={id}
          type="text"
          inputMode="text"
          value={value}
          placeholder="#4338CA"
          maxLength={7}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(field, event.currentTarget.value)}
          className={`${inputClass} mt-0 max-w-[10rem] font-mono`}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange(field, null)}
            className={buttonClass('ghost', 'sm')}
          >
            Clear<span className="sr-only"> {label.toLowerCase()}</span>
          </button>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
