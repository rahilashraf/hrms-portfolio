import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

import RecruitmentIndexPage from '../../app/(app)/(authenticated)/recruitment/page';

describe('/recruitment (Batch 7A)', () => {
  it('opens Recruitment administration instead of a 404', () => {
    RecruitmentIndexPage();
    expect(redirect).toHaveBeenCalledWith('/admin/recruitment');
  });
});
