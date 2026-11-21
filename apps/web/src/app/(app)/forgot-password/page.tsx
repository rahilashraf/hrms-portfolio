'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import {
  AuthShell,
  FormField,
  FormMessage,
  SubmitButton,
} from '../../../components/auth/auth-shell';
import { authErrorMessage, rateLimitedMessage } from '../../../lib/auth/error-message';
import { forgotPassword } from '../../../lib/auth/api-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const result = await forgotPassword(email);
      setMessage(result.message);
    } catch (cause) {
      setError(rateLimitedMessage(cause) ?? authErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Enter your account email. If eligible, recovery instructions will be sent."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <FormField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {message && <FormMessage success>{message}</FormMessage>}
        {error && <FormMessage>{error}</FormMessage>}
        <SubmitButton busy={busy}>Send instructions</SubmitButton>
      </form>
      <Link
        className="mt-5 inline-block text-sm font-medium text-indigo-700 hover:underline"
        href="/login"
      >
        Back to sign in
      </Link>
    </AuthShell>
  );
}
