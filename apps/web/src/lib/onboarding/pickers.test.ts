import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onboardingOptionSource } from './pickers';

const options = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ onboardingApi: { options } }));

beforeEach(() => options.mockReset());

describe('onboardingOptionSource (Batch 7A)', () => {
  it('pages the scoped options and marks a restartable hire', async () => {
    options.mockResolvedValue({
      items: [
        { id: 'h-1', label: 'Grace Hopper', description: 'E-12', restartable: true },
        { id: 'h-2', label: 'Alan Turing', description: 'E-13', restartable: false },
      ],
      nextAfterId: 'h-2',
    });
    const page = await onboardingOptionSource('org-1', 'hire').search('gr', 'h-0');
    expect(options).toHaveBeenCalledWith('org-1', 'hire', {
      search: 'gr',
      afterId: 'h-0',
      limit: 20,
    });
    expect(page).toEqual({
      items: [
        {
          id: 'h-1',
          label: 'Grace Hopper',
          description: 'E-12 · Earlier onboarding cancelled — starts a new one',
        },
        { id: 'h-2', label: 'Alan Turing', description: 'E-13' },
      ],
      next: 'h-2',
    });
  });

  it('passes the workflow kind for assignments', async () => {
    options.mockResolvedValue({ items: [], nextAfterId: null });
    await onboardingOptionSource('org-1', 'assignment', 'OFFBOARDING').search('', null);
    expect(options).toHaveBeenCalledWith('org-1', 'assignment', {
      workflowKind: 'OFFBOARDING',
      limit: 20,
    });
  });
});
