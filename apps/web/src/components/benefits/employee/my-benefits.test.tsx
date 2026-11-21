import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type { Election, EligibilityPlan } from '../../../lib/benefits/types';
import { MyBenefitsPage } from '../my-benefits-page';

const mocks = vi.hoisted(() => ({
  api: { mine: vi.fn(), myDependents: vi.fn(), myEligibility: vi.fn() },
}));
vi.mock('../../../lib/benefits/api', () => ({ benefitsApi: mocks.api }));
const api = mocks.api;

const election = (overrides: Partial<Election> = {}): Election => ({
  id: 'enr-1',
  status: 'ACTIVE',
  electionType: 'ENROLLED',
  recordType: 'INITIAL',
  plan: {
    id: 'plan-1',
    code: 'HEALTH',
    name: 'Health',
    benefitType: 'HEALTH',
    providerName: null,
    currency: 'CAD',
  },
  option: { id: 'opt-1', code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
  coverageStart: '2026-01-01',
  coverageEnd: null,
  electedOn: '2026-01-01',
  sponsoringAssignment: { id: 'asg-1', positionName: 'Analyst', organizationName: 'Acme' },
  dependents: [],
  cost: null,
  ...overrides,
});

const offered = (plans: EligibilityPlan[]) => ({
  items: [
    {
      assignmentId: 'asg-1',
      positionName: 'Analyst',
      organization: 'Acme',
      date: '2026-03-15',
      plans,
    },
  ],
});

const plan = (overrides: Partial<EligibilityPlan> = {}): EligibilityPlan => ({
  planId: 'plan-2',
  code: 'VISION',
  name: 'Vision',
  benefitType: 'VISION',
  status: 'ACTIVE',
  options: [{ id: 'opt-v', code: 'SINGLE', name: 'Vision single', coverageLevel: 'EMPLOYEE_ONLY' }],
  eligibility: { eligible: true, reasons: [], rules: [] },
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => cleanup());

describe('MyBenefitsPage (Batch 7C)', () => {
  it('tells a missing employee record apart from a disabled module', async () => {
    api.mine.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'BENEFIT_NOT_AN_EMPLOYEE' }),
    );
    api.myDependents.mockResolvedValue({ items: [] });
    api.myEligibility.mockResolvedValue({ items: [] });
    render(<MyBenefitsPage />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
    cleanup();
    api.mine.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'FEATURE_DISABLED' }),
    );
    render(<MyBenefitsPage />);
    expect(await screen.findByText(/turned off/)).toBeInTheDocument();
    expect(screen.queryByText(/not linked/)).not.toBeInTheDocument();
  });

  it('keeps what loaded when one part fails, with a retry for that part', async () => {
    api.mine.mockResolvedValue({ employeeId: 'emp-1', items: [election()] });
    api.myDependents.mockRejectedValueOnce(new AuthApiError('unexpected', 500));
    api.myEligibility.mockResolvedValue({ items: [] });
    render(<MyBenefitsPage />);
    const current = await screen.findByRole('region', { name: 'Current and upcoming' });
    expect(await within(current).findByText('Health')).toBeInTheDocument();
    const dependents = screen.getByRole('region', { name: 'Dependents' });
    expect(await within(dependents).findByRole('alert')).toHaveTextContent(/unavailable/);
    api.myDependents.mockResolvedValue({
      items: [
        {
          id: 'dep-1',
          employeeId: 'emp-1',
          firstName: 'Kit',
          lastName: 'Doe',
          relationship: 'CHILD',
          dateOfBirth: '2015-07-01',
          relationshipStartDate: null,
          relationshipEndDate: null,
          archived: false,
        },
      ],
    });
    fireEvent.click(within(dependents).getByRole('button', { name: 'Try again' }));
    expect(await within(dependents).findByText('Kit Doe')).toBeInTheDocument();
  });

  it('offers a plan again once its earlier coverage ended', async () => {
    api.mine.mockResolvedValue({
      employeeId: 'emp-1',
      items: [
        election({
          id: 'enr-old',
          status: 'ENDED',
          coverageEnd: '2025-12-31',
          plan: { ...election().plan, id: 'plan-2', name: 'Vision' },
        }),
      ],
    });
    api.myDependents.mockResolvedValue({ items: [] });
    api.myEligibility.mockResolvedValue(offered([plan()]));
    render(<MyBenefitsPage />);
    const region = await screen.findByRole('region', { name: 'Plans you are eligible for' });
    expect(within(region).getByText('Vision single')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Past coverage' })).toHaveTextContent('Vision');
    // Self-service stays read-only.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
