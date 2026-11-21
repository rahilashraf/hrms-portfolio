'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthShell, FormMessage } from '../../../components/auth/auth-shell';
import { authErrorMessage } from '../../../lib/auth/error-message';
import { readFragmentToken, removeTokenFragment } from '../../../lib/auth/recovery-token';
import { verifyEmail } from '../../../lib/auth/api-client';

export default function VerifyEmailPage() {
  const [token] = useState(readFragmentToken);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    removeTokenFragment();
    if (started.current) return;
    started.current = true;
    if (!token) {
      void Promise.resolve().then(() => {
        setError('This link is invalid or has expired. Request a new one.');
        setStatus('error');
      });
      return;
    }
    void verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((cause: unknown) => {
        setError(
          authErrorMessage(
            cause,
            'unexpected',
            'This link is invalid or has expired. Request a new one.',
          ),
        );
        setStatus('error');
      });
  }, [token]);

  return (
    <AuthShell title="Verify your email" description="We are checking your verification link.">
      {status === 'loading' && (
        <p role="status" className="text-sm text-slate-600">
          Verifying your email…
        </p>
      )}
      {status === 'success' && (
        <>
          <FormMessage success>Your email address is verified.</FormMessage>
          <Link
            className="mt-5 inline-block text-sm font-medium text-indigo-700 hover:underline"
            href="/login"
          >
            Continue to sign in
          </Link>
        </>
      )}
      {status === 'error' && (
        <>
          <FormMessage>{error}</FormMessage>
          <Link
            className="mt-5 inline-block text-sm font-medium text-indigo-700 hover:underline"
            href="/resend-verification"
          >
            Request another verification email
          </Link>
        </>
      )}
    </AuthShell>
  );
}
