'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../providers/auth-provider';
import { AuthShell } from '../auth/auth-shell';
import { buttonClass } from '../ui/button';
import { ChangePasswordForm } from './change-password-form';

/**
 * Batch 2: the page a user who must change their password sees before anything else (outside
 * the app shell, which would load data the API refuses until then). Signing out stays possible.
 */
export function RequiredPasswordChange() {
  const { status, identity, logout, passwordChanged } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated' || !identity) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-600">
        Checking your session…
      </main>
    );
  }
  const required = identity.mustChangePassword;
  return (
    <AuthShell
      title={required ? 'Choose a new password' : 'Change your password'}
      description={
        required
          ? 'Your account requires a new password before you continue. Your other sessions will be signed out.'
          : 'Your other sessions will be signed out.'
      }
    >
      <ChangePasswordForm
        submitLabel="Save new password"
        onChanged={() => {
          passwordChanged();
          router.replace('/dashboard');
        }}
      />
      <button
        type="button"
        onClick={() => void logout().then(() => router.replace('/login'))}
        className={`${buttonClass('ghost', 'sm')} mt-4`}
      >
        Sign out
      </button>
    </AuthShell>
  );
}
