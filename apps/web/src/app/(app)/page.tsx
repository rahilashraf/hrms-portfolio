'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../providers/auth-provider';

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-slate-600">
      Checking your session…
    </main>
  );
}
