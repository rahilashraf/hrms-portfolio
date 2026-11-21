'use client';

import { recruitmentApi } from '../../../lib/recruitment/api';
import type { ApplicationDetail } from '../../../lib/recruitment/types';
import { secondaryButton } from '../recruitment-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { Run } from './application-shared';

// Batch 10E-1: withdraw / reject (moved from application-page.tsx unchanged).
export function Disposition({
  application,
  busy,
  run,
}: {
  application: ApplicationDetail;
  busy: boolean;
  run: Run;
}) {
  return (
    <section
      aria-label="Close application"
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
    >
      <h2 className="text-base font-semibold text-slate-900">Close application</h2>
      <p className="text-sm text-slate-600">
        Withdrawing (the candidate stepped back) or rejecting closes the application for good; both
        ask for a reason.
      </p>
      <div className="flex flex-wrap gap-2">
        {application.actions.canWithdraw && (
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: `Withdraw ${application.candidate.displayName}'s application?`,
              description: 'The application is closed as withdrawn by the candidate.',
              confirmLabel: 'Withdraw application',
              destructive: true,
              reason: { label: 'Reason', required: true },
            }}
            onConfirm={(reason) =>
              void run(
                () => recruitmentApi.withdraw(application.id, reason),
                'Application withdrawn.',
              )
            }
          >
            Withdraw application
          </ConfirmButton>
        )}
        {application.actions.canReject && (
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: `Reject ${application.candidate.displayName}'s application?`,
              description: 'The application is closed as rejected.',
              confirmLabel: 'Reject application',
              destructive: true,
              reason: { label: 'Reason', required: true },
            }}
            onConfirm={(reason) =>
              void run(() => recruitmentApi.reject(application.id, reason), 'Application rejected.')
            }
          >
            Reject application
          </ConfirmButton>
        )}
      </div>
    </section>
  );
}
