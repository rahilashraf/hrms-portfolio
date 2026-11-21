'use client';

import { useState } from 'react';
import { PageContainer } from '../ui/page-container';
import { PageHeader } from '../ui/page-header';
import { AccountSessions } from './account-sessions';
import { ChangePasswordForm } from './change-password-form';

/** Batch 2: password and sessions of the signed-in account (any account, employee or not). */
export function AccountSecurityPage() {
  const [changed, setChanged] = useState('');
  const [sessionsVersion, setSessionsVersion] = useState(0);
  return (
    <PageContainer width="narrow" className="space-y-8">
      <PageHeader
        title="Account security"
        description="Change your password and see where your account is signed in."
      />
      <section aria-labelledby="password-heading" className="space-y-4">
        <h2 id="password-heading" className="text-lg font-semibold text-slate-900">
          Password
        </h2>
        {changed && (
          <p role="status" className="text-sm text-emerald-800">
            {changed}
          </p>
        )}
        <ChangePasswordForm
          onChanged={({ revokedSessionCount }) => {
            setChanged(
              revokedSessionCount === 0
                ? 'Your password was changed.'
                : `Your password was changed and ${
                    revokedSessionCount === 1
                      ? 'one other session was'
                      : `${revokedSessionCount} other sessions were`
                  } signed out.`,
            );
            setSessionsVersion((version) => version + 1);
          }}
        />
      </section>
      <section aria-labelledby="sessions-heading" className="space-y-4">
        <h2 id="sessions-heading" className="text-lg font-semibold text-slate-900">
          Where you are signed in
        </h2>
        <AccountSessions key={sessionsVersion} />
      </section>
    </PageContainer>
  );
}
