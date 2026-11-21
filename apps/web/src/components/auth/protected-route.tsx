'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../providers/auth-provider';

export const CHANGE_PASSWORD_PATH = '/account/change-password';

/**
 * Signed-in pages. A user who must change their password (Batch 2) is sent to the change form
 * before anything else loads; the API enforces the same rule on every request.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, identity } = useAuth();
  const router = useRouter();
  const mustChange = status === 'authenticated' && Boolean(identity?.mustChangePassword);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    } else if (mustChange) {
      router.replace(CHANGE_PASSWORD_PATH);
    }
  }, [status, mustChange, router]);

  if (status !== 'authenticated' || mustChange) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-600">
        {mustChange ? 'Opening the password change…' : 'Checking your session…'}
      </main>
    );
  }
  return children;
}
