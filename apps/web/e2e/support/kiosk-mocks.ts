import type { Page } from '@playwright/test';
import { API } from './api-origin';

// Batch 10F: moved unchanged from e2e/kiosk.spec.ts so ui-acceptance-flows.spec.ts can reuse it.
export const kioskSession = {
  device: { id: 'device-1', name: 'Front desk' },
  location: { name: 'Main lodge', timezone: 'America/Toronto' },
  organization: { name: 'Camp' },
  interactionSeconds: 90,
};

export const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

export interface KioskMock {
  enrolled: boolean;
  identification: unknown;
  actions: Array<Record<string, unknown>>;
}

export async function mockKiosk(page: Page, mock: KioskMock) {
  await page.route(`${API}/kiosk/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/kiosk/session') {
      return route.fulfill(
        mock.enrolled
          ? json(kioskSession)
          : json(
              {
                code: 'KIOSK_DEVICE_UNAUTHENTICATED',
                message: 'This device is not an enrolled kiosk.',
              },
              401,
            ),
      );
    }
    if (path === '/kiosk/enroll') {
      mock.enrolled = true;
      return route.fulfill(json(kioskSession, 201));
    }
    if (path === '/kiosk/identify') return route.fulfill(json(mock.identification, 201));
    if (path === '/kiosk/actions') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mock.actions.push(body);
      return route.fulfill(
        json(
          {
            action: body.action,
            outcome: body.action === 'SIGN_IN' ? 'SIGNED_IN' : 'RECORDED',
            occurredAt: '2026-10-05T13:02:00.000Z',
            timezone: 'America/Toronto',
          },
          201,
        ),
      );
    }
    if (path === '/kiosk/cancel') return route.fulfill(json({ cancelled: true }, 201));
    return route.fulfill(json({}, 404));
  });
}
