'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  AuthShell,
  FormField,
  FormMessage,
  SubmitButton,
} from '../../../components/auth/auth-shell';
import { authErrorMessage, rateLimitedMessage } from '../../../lib/auth/error-message';
import { brandingApi } from '../../../lib/branding/api';
import { DEFAULT_PUBLIC_BRANDING, type PublicBranding } from '../../../lib/branding/types';
import { useAuth } from '../../../providers/auth-provider';
import { useDocumentTitle } from '../../../components/ui/use-document-title';

export default function LoginPage() {
  const { status, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Public login branding: generic until (and unless) it loads; never blocks signing in.
  const [branding, setBranding] = useState<PublicBranding>(DEFAULT_PUBLIC_BRANDING);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  useEffect(() => {
    let active = true;
    const code = new URLSearchParams(window.location.search).get('organization');
    void brandingApi.publicBranding(code).then((value) => {
      if (active) setBranding(value);
    });
    return () => {
      active = false;
    };
  }, []);

  useDocumentTitle(`Sign in · ${branding.shortName || branding.displayName || 'HRMS'}`);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      router.replace('/dashboard');
    } catch (cause) {
      setError(rateLimitedMessage(cause) ?? authErrorMessage(cause, 'invalid-credentials'));
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading' || status === 'authenticated') {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-600">
        Checking your session…
      </main>
    );
  }

  return (
    <AuthShell
      branding={branding}
      title="Sign in to your account"
      description="Use the email address associated with your account."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <FormField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <FormField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <FormMessage>{error}</FormMessage>}
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
      <p className="mt-5 text-sm text-slate-600">
        <Link className="font-medium text-indigo-700 hover:underline" href="/forgot-password">
          Forgot your password?
        </Link>
      </p>
    </AuthShell>
  );
}
