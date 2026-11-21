'use client';

import { checkboxClass } from '../tokens';

import {
  cloneElement,
  useId,
  type ReactElement,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { buttonClass, type ButtonSize, type ButtonVariant } from '../button';
import { inputClass } from '../tokens';

/** What a control needs to be tied to its label, hint and error. */
export interface FieldControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
  'aria-required'?: true;
}

/**
 * Batch 3B — one form field: a label, an optional hint and an error, tied to the control the
 * render function returns (`id`, `aria-invalid`, `aria-describedby`, `aria-required`). The
 * error is announced (`role="alert"`) and replaces nothing: the hint stays. Works with any
 * control; with React Hook Form use the InputField/SelectField/TextareaField wrappers below.
 */
export function FormField({
  id: givenId,
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  className,
  children,
}: {
  /** The control's id (generated when omitted); the label is `${id}-label`. */
  id?: string;
  label: ReactNode;
  /** Keep the label for assistive technology only (e.g. in a table row). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children(control: FieldControlProps): ReactNode;
}) {
  const generatedId = useId();
  const id = givenId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label
        id={`${id}-label`}
        htmlFor={id}
        className={hideLabel ? 'sr-only' : 'block text-sm font-medium text-slate-800'}
      >
        {label}
        {required && (
          <span aria-hidden="true" className="text-rose-700">
            {' '}
            *
          </span>
        )}
      </label>
      {children({
        id,
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(required ? { 'aria-required': true as const } : {}),
      })}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Batch 10E-2 — `FormField` for one native control given as its child (an existing `useState`
 * form that is not moving to React Hook Form): the label is tied to the control by `htmlFor`/`id`
 * and the hint by `aria-describedby`. The control keeps its own value, handlers and attributes.
 */
export function ControlField({
  label,
  hint,
  className = 'min-w-0',
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  return (
    <FormField label={label} hint={hint} className={className}>
      {({ id, 'aria-describedby': hintId }) => {
        // The hint is added to whatever the control already points at (e.g. its own error).
        const describedBy =
          [hintId, children.props['aria-describedby']].filter(Boolean).join(' ') || undefined;
        return cloneElement(children, {
          id,
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        });
      }}
    </FormField>
  );
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  /** `register('name')` from React Hook Form (or any compatible {name, ref, onChange, onBlur}). */
  registration: UseFormRegisterReturn;
}

export function InputField({
  label,
  hint,
  error,
  required,
  className,
  registration,
  ...input
}: FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name'>) {
  return (
    <FormField label={label} hint={hint} error={error} required={required} className={className}>
      {(control) => <input className={inputClass} {...input} {...control} {...registration} />}
    </FormField>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  className,
  registration,
  children,
  ...select
}: FieldProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'name'>) {
  return (
    <FormField label={label} hint={hint} error={error} required={required} className={className}>
      {(control) => (
        <select className={inputClass} {...select} {...control} {...registration}>
          {children}
        </select>
      )}
    </FormField>
  );
}

export function TextareaField({
  label,
  hint,
  error,
  required,
  className,
  registration,
  ...textarea
}: FieldProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'name'>) {
  return (
    <FormField label={label} hint={hint} error={error} required={required} className={className}>
      {(control) => (
        <textarea className={inputClass} rows={3} {...textarea} {...control} {...registration} />
      )}
    </FormField>
  );
}

/** A checkbox with its label to the right; hint and error below, tied the same way. */
export function CheckboxField({
  label,
  hint,
  error,
  className,
  registration,
  ...input
}: Omit<FieldProps, 'required'> &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name' | 'type'>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          id={id}
          className={checkboxClass}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
          {...input}
          {...registration}
        />
        {label}
      </label>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}

/** A submit button that shows progress and cannot be pressed twice while busy. */
export function SubmitButton({
  busy,
  busyLabel = 'Saving…',
  children,
  variant = 'primary',
  size = 'md',
  disabled,
}: {
  busy: boolean;
  busyLabel?: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={buttonClass(variant, size)}
    >
      {busy ? busyLabel : children}
    </button>
  );
}
