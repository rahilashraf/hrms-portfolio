import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../auth/api-client';
import { organizationApi } from './api';

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('organization API client', () => {
  beforeEach(() => {
    setAccessToken('test-token');
    vi.unstubAllGlobals();
  });

  it('uses the authenticated API client and requests archived organizations explicitly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(organizationApi.listOrganizations(true)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/organizations?includeArchived=true',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('Authorization')).toBe(
      'Bearer test-token',
    );
  });

  it('uses the approved organization structure route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    await organizationApi.getStructure('org/with-space');

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3001/organizations/org%2Fwith-space/structure',
    );
  });

  it('requests the position reference options of one organization', async () => {
    const options = { jobTitles: [], workLocations: [] };
    const fetchMock = vi.fn().mockResolvedValue(response(options));
    vi.stubGlobal('fetch', fetchMock);

    await expect(organizationApi.listPositionReferenceOptions('org-1')).resolves.toEqual(options);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3001/organizations/org-1/position-reference-options',
    );
  });
});
