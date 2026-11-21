import type { ReactNode } from 'react';
import { ProtectedRoute } from '../../../components/auth/protected-route';
import { AppShell } from '../../../components/shell/app-shell';
import { WorkspaceProvider } from '../../../providers/workspace-provider';

export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <WorkspaceProvider>
        <AppShell>{children}</AppShell>
      </WorkspaceProvider>
    </ProtectedRoute>
  );
}
