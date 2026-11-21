import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schedulingApi } from './api';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => apiRequest.mockReset());

describe('schedulingApi', () => {
  it('reads only the signed-in employee’s own schedule', async () => {
    apiRequest.mockResolvedValue({ items: [] });
    await schedulingApi.mySchedule('2026-10-05', '2026-10-18');
    await schedulingApi.mySchedule('2026-10-05', '2026-10-18', true);
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/scheduling/me?from=2026-10-05&to=2026-10-18');
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      '/scheduling/me?from=2026-10-05&to=2026-10-18&includeCancelled=true',
    );
  });
});
