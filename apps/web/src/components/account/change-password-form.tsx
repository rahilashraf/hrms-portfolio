'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from '../../lib/forms/zod';
import { changePassword } from '../../lib/auth/api-client';
import { authErrorMessage, rateLimitedMessage } from '../../lib/auth/error-message';
import { AuthApiError } from '../../lib/auth/types';
import { InputField, SubmitButton } from '../ui/form/form-field';
import { InlineMessage } from '../ui/inline-message';

/** Mirrors the API: the shared 12–128 character policy, counted in characters. */
const policy = (value: string) => {
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
};

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().refine(policy, 'Use 12 to 128 characters.'),
    confirmation: z.string(),
  })
  .refine((values) => values.confirmation === values.newPassword, {
    path: ['confirmation'],
    message: 'The passwords do not match.',
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one.',
  });

type FormValues = z.infer<typeof changePasswordSchema>;

const FIELDS = [
  { name: 'currentPassword', label: 'Current password', autoComplete: 'current-password' },
  {
    name: 'newPassword',
    label: 'New password',
    autoComplete: 'new-password',
    hint: '12 to 128 characters. A passphrase of several words works well.',
  },
  { name: 'confirmation', label: 'Confirm new password', autoComplete: 'new-password' },
] as const;

/**
 * Batch 2: changing one's own password. The current password is required; on success every
 * other session is signed out (the API reports how many).
 */
export function ChangePasswordForm({
  submitLabel = 'Change password',
  onChanged,
}: {
  submitLabel?: string;
  onChanged(result: { revokedSessionCount: number }): void;
}) {
  const [formError, setFormError] = useState('');
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmation: '' },
  });

  const submit = handleSubmit(async (values) => {
    setFormError('');
    try {
      const result = await changePassword(values.currentPassword, values.newPassword);
      reset();
      onChanged({ revokedSessionCount: result.revokedSessionCount });
    } catch (cause) {
      const code = cause instanceof AuthApiError ? cause.details?.code : undefined;
      if (code === 'CURRENT_PASSWORD_INVALID') {
        setError('currentPassword', { message: 'The current password is incorrect.' });
      } else if (code === 'PASSWORD_UNCHANGED') {
        setError('newPassword', {
          message: 'Choose a password different from the current one.',
        });
      } else if (code === 'PASSWORD_CHANGED_CONCURRENTLY') {
        setFormError('Your password was changed meanwhile. Sign in again and retry.');
      } else if (cause instanceof AuthApiError && cause.status === 400) {
        setError('newPassword', { message: 'Use 12 to 128 characters.' });
      } else {
        setFormError(rateLimitedMessage(cause) ?? authErrorMessage(cause));
      }
    }
  });

  return (
    <form
      aria-label="Change password"
      noValidate
      onSubmit={(event) => void submit(event)}
      className="space-y-4"
    >
      {FIELDS.map((field) => (
        <InputField
          key={field.name}
          className="max-w-sm"
          label={field.label}
          hint={'hint' in field ? field.hint : undefined}
          error={errors[field.name]?.message}
          type="password"
          autoComplete={field.autoComplete}
          maxLength={1024}
          registration={register(field.name)}
        />
      ))}
      {formError && <InlineMessage tone="error">{formError}</InlineMessage>}
      <SubmitButton busy={isSubmitting} busyLabel="Changing…">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
