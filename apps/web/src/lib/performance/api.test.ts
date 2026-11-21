import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performanceApi } from './api';
import { performanceOptionSource } from './pickers';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({ items: [], nextAfterId: null });
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [
    call[0],
    call[1]?.method ?? 'GET',
    call[1]?.body ? JSON.parse(call[1].body as string) : undefined,
  ]);

describe('performanceApi (Batch 7B)', () => {
  it('maps cycle detail, edit, discard, targeted add, removal and filtered monitoring', async () => {
    await performanceApi.cycle('c/1');
    await performanceApi.updateCycle('c1', { name: 'Annual 2026' });
    await performanceApi.discardCycle('c1');
    await performanceApi.addReviews('c1', { allInOrganization: true, teamId: 't1' });
    await performanceApi.removeReview('c1', 'r1');
    await performanceApi.cycleReviews('c1');
    await performanceApi.cycleReviews('c1', { status: 'SUBMITTED', search: 'Ada', limit: 50 });
    expect(calls()).toEqual([
      ['/performance/cycles/c%2F1', 'GET', undefined],
      ['/performance/cycles/c1', 'PATCH', { name: 'Annual 2026' }],
      ['/performance/cycles/c1', 'DELETE', undefined],
      ['/performance/cycles/c1/reviews', 'POST', { allInOrganization: true, teamId: 't1' }],
      ['/performance/cycles/c1/reviews/r1', 'DELETE', undefined],
      ['/performance/cycles/c1/reviews', 'GET', undefined],
      ['/performance/cycles/c1/reviews?status=SUBMITTED&search=Ada&limit=50', 'GET', undefined],
    ]);
  });

  it('maps configuration edits and archives', async () => {
    await performanceApi.updateCompetency('k1', { name: 'Communication' });
    await performanceApi.updateScale('s1', { name: 'Five point' });
    await performanceApi.transitionScale('s1', 'archive');
    await performanceApi.updateTemplate('t1', { name: 'Annual' });
    await performanceApi.copyTemplate('t1', 'ANNUAL-2027', 'Annual 2027');
    await performanceApi.updateEvidenceSource('src1', { name: 'Quiz' });
    await performanceApi.archiveEvidenceSource('src1');
    expect(calls()).toEqual([
      ['/performance/competencies/k1', 'PATCH', { name: 'Communication' }],
      ['/performance/rating-scales/s1', 'PATCH', { name: 'Five point' }],
      ['/performance/rating-scales/s1/archive', 'POST', undefined],
      ['/performance/templates/t1', 'PATCH', { name: 'Annual' }],
      ['/performance/templates/t1/copy', 'POST', { code: 'ANNUAL-2027', name: 'Annual 2027' }],
      ['/performance/evidence-sources/src1', 'PATCH', { name: 'Quiz' }],
      ['/performance/evidence-sources/src1/archive', 'POST', undefined],
    ]);
  });

  it('maps the evidence lifecycle and filtered queues', async () => {
    await performanceApi.recordEvidence({
      organizationId: 'o1',
      employeeId: 'e1',
      provider: 'CERTIFICATION',
      kind: 'CERTIFICATION',
      title: 'First Aid',
      completedAt: '2026-05-20T12:00:00.000Z',
    });
    await performanceApi.correctEvidence('ev1', { title: 'First Aid (CPR)', reason: 'Name' });
    await performanceApi.remapEvidence('ev1', { employeeId: 'e2', reason: 'Wrong person' });
    await performanceApi.withdrawEvidence('ev1', 'Duplicate');
    await performanceApi.evidenceHistory('ev1');
    await performanceApi.intake('o1', { status: 'REJECTED', sourceId: 'src1', afterId: 'i9' });
    await performanceApi.attention('o1', { flag: 'NO_REVIEWER' });
    await performanceApi.employeeEvidence('e1', 'ACTIVE');
    await performanceApi.employeeGoals('e1', 'COMPLETED');
    await performanceApi.myGoals();
    await performanceApi.employeeGoals('e1', undefined, { limit: 25, afterId: 'g9' });
    await performanceApi.myEvidence({ limit: 10 });
    expect(calls()).toEqual([
      [
        '/performance/evidence',
        'POST',
        {
          organizationId: 'o1',
          employeeId: 'e1',
          provider: 'CERTIFICATION',
          kind: 'CERTIFICATION',
          title: 'First Aid',
          completedAt: '2026-05-20T12:00:00.000Z',
        },
      ],
      ['/performance/evidence/ev1/correct', 'POST', { title: 'First Aid (CPR)', reason: 'Name' }],
      ['/performance/evidence/ev1/remap', 'POST', { employeeId: 'e2', reason: 'Wrong person' }],
      ['/performance/evidence/ev1/withdraw', 'POST', { reason: 'Duplicate' }],
      ['/performance/evidence/ev1/history', 'GET', undefined],
      [
        '/performance/evidence-intake?organizationId=o1&status=REJECTED&sourceId=src1&afterId=i9',
        'GET',
        undefined,
      ],
      ['/performance/attention?organizationId=o1&flag=NO_REVIEWER', 'GET', undefined],
      ['/performance/employees/e1/evidence?status=ACTIVE', 'GET', undefined],
      ['/performance/employees/e1/goals?status=COMPLETED', 'GET', undefined],
      ['/performance/me/goals', 'GET', undefined],
      ['/performance/employees/e1/goals?limit=25&afterId=g9', 'GET', undefined],
      ['/performance/me/evidence?limit=10', 'GET', undefined],
    ]);
  });

  it('pages module-scoped picker options', async () => {
    apiRequest.mockResolvedValueOnce({
      items: [{ id: 'a1', label: 'Ada Lovelace', employeeId: 'e1' }],
      nextAfterId: 'a1',
    });
    const page = await performanceOptionSource('o1', 'assignment', {
      employeeId: 'e1',
    }).search('Ada', 'a0');
    expect(page).toEqual({
      items: [{ id: 'a1', label: 'Ada Lovelace', employeeId: 'e1' }],
      next: 'a1',
    });
    expect(calls()).toEqual([
      [
        '/performance/options?organizationId=o1&kind=assignment&search=Ada&employeeId=e1&limit=20&afterId=a0',
        'GET',
        undefined,
      ],
    ]);
  });
});
