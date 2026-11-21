'use client';

import type { ReactNode } from 'react';
import { ToastProvider } from '../../components/ui/toast';
import { AuthProvider } from '../../providers/auth-provider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}
