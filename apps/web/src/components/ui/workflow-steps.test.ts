import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { balanceImpactText } from '../leave/leave-shared';
import { documentTasks } from '../onboarding/workflow-page';
import { runNextStep } from '../payroll/payroll-run-page';
import { hiringJourney } from '../recruitment/application-page';

const states = (steps: Array<{ state: string }>) => steps.map((step) => step.state);

describe('payroll run next step', () => {
  const actions = { canCalculate: true, canApprove: true, canFinalize: true };
  it('names the primary action for each real run state', () => {
    expect(runNextStep({ status: 'DRAFT', actions } as never)).toMatch(/calculate/i);
    expect(runNextStep({ status: 'CALCULATED', actions } as never)).toMatch(/approve/i);
    expect(runNextStep({ status: 'APPROVED', actions } as never)).toMatch(/finalize/i);
    expect(runNextStep({ status: 'FINALIZED', actions } as never)).toMatch(/adjustments/i);
    expect(runNextStep({ status: 'VOIDED', actions } as never)).toMatch(/voided/i);
  });
  it('says who it waits for when the caller cannot act', () => {
    const none = { canCalculate: false, canApprove: false, canFinalize: false };
    expect(runNextStep({ status: 'CALCULATED', actions: none } as never)).toBe(
      'Waiting for review and approval.',
    );
  });
});

describe('hiring journey', () => {
  const base = {
    status: 'ACTIVE',
    stage: { id: 's', name: 'Applied', kind: 'APPLIED' },
    interviews: [],
    offers: [],
  };
  it('derives progress from status, stage kind, interviews and offers', () => {
    expect(states(hiringJourney(base as never))).toEqual([
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    expect(states(hiringJourney({ ...base, interviews: [{}] } as never))).toEqual([
      'complete',
      'current',
      'upcoming',
      'upcoming',
    ]);
    expect(states(hiringJourney({ ...base, status: 'OFFERED' } as never))).toEqual([
      'complete',
      'complete',
      'current',
      'upcoming',
    ]);
    expect(states(hiringJourney({ ...base, status: 'HIRED' } as never))).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
  });
  it('skips unreached steps for closed applications', () => {
    expect(
      states(
        hiringJourney({
          ...base,
          status: 'REJECTED',
          stage: { ...base.stage, kind: 'INTERVIEW' },
        } as never),
      ),
    ).toEqual(['complete', 'complete', 'skipped', 'skipped']);
  });
});

describe('onboarding documents', () => {
  it('lists tasks with a document reference or an acknowledgement', () => {
    const tasks = [
      { id: '1', reference: null, acknowledgementRequired: false },
      { id: '2', reference: { type: 'GOOGLE_DOC' }, acknowledgementRequired: false },
      { id: '3', reference: null, acknowledgementRequired: true },
    ];
    expect(documentTasks(tasks as never).map((task) => task.id)).toEqual(['2', '3']);
  });
});

describe('leave balance impact', () => {
  const detail = {
    requestedMinutes: 480,
    approvedMinutes: 480,
    activeMinutes: 240,
    leaveType: { displayUnit: 'HOURS' },
  };
  it('explains the impact from the request’s own amounts', () => {
    expect(balanceImpactText({ ...detail, status: 'PENDING' } as never)).toMatch(/would use 8/);
    expect(balanceImpactText({ ...detail, status: 'APPROVED' } as never)).toMatch(/uses 4/);
    expect(balanceImpactText({ ...detail, status: 'REJECTED' } as never)).toMatch(/does not use/);
    expect(balanceImpactText({ ...detail, status: 'CANCELLED' } as never)).toMatch(/already taken/);
    expect(
      balanceImpactText({ ...detail, activeMinutes: 0, status: 'CANCELLED' } as never),
    ).toMatch(/does not use/);
  });
});
