import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditActorSource } from './entity-types';

const mocks = vi.hoisted(() => ({ actors: vi.fn() }));
vi.mock('./api', () => ({ auditApi: { actors: mocks.actors } }));

beforeEach(() => vi.clearAllMocks());

describe('auditActorSource (R4-A.7)', () => {
  it('keeps the server’s name order across pages, passing the cursor through', async () => {
    mocks.actors
      .mockResolvedValueOnce({
        items: [
          { userId: 'u-3', displayName: 'Ada Lovelace' },
          { userId: 'u-1', displayName: 'Ada Lovelace' },
        ],
        nextAfterId: 'u-1',
      })
      .mockResolvedValueOnce({
        items: [
          { userId: 'u-2', displayName: 'Grace Hopper' },
          { userId: 'u-9', displayName: null },
        ],
        nextAfterId: null,
      });
    const source = auditActorSource('org-1', { from: '2026-10-01' });
    const first = await source.search('', null);
    const second = await source.search('', first.next ?? null);
    expect([...first.items, ...second.items].map((item) => item.label)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
      'Grace Hopper',
      'Unnamed user',
    ]);
    // Equal names stay distinguishable.
    expect(first.items.map((item) => item.description)).toEqual(['User u-3', 'User u-1']);
    expect(mocks.actors).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: 'org-1', afterId: 'u-1', from: '2026-10-01' }),
    );
  });
});
