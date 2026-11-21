'use client';

import { useState, type FormEvent } from 'react';
import { AuthShell, FormField, FormMessage, SubmitButton } from './auth-shell';
import { authErrorMessage } from '../../lib/auth/error-message';

export function PasswordTokenForm({
  title,
  description,
  submitLabel,
  token,
  onSubmit,
}: {
  title: string;
  description: string;
  submitLabel: string;
  token: string | null;
  onSubmit(token: string, password: string): Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!token) {
      setError('This link is invalid or has expired. Request a new one.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(token, password);
      setMessage('Your password has been set. You can now sign in.');
      setPassword('');
      setConfirmation('');
    } catch (cause) {
      setError(
        authErrorMessage(
          cause,
          'unexpected',
          'This link is invalid or has expired. Request a new one.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={title} description={description}>
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <FormField
          label="New password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FormField
          label="Confirm password"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {message && <FormMessage success>{message}</FormMessage>}
        {error && <FormMessage>{error}</FormMessage>}
        <SubmitButton busy={busy}>{submitLabel}</SubmitButton>
      </form>
    </AuthShell>
  );
}
