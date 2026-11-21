import { HSTS_HEADER, securityHeadersMiddleware } from './http-application.js';

function run(production: boolean) {
  const headers: Record<string, string> = {};
  const next = vi.fn();
  securityHeadersMiddleware(production)(
    {} as never,
    {
      setHeader: (name: string, value: string) => (headers[name] = value),
    } as never,
    next,
  );
  expect(next).toHaveBeenCalled();
  return headers;
}

describe('securityHeadersMiddleware', () => {
  it('sends HSTS only in production', () => {
    expect(run(true)['Strict-Transport-Security']).toBe(HSTS_HEADER);
    expect(run(false)['Strict-Transport-Security']).toBeUndefined();
  });

  it('defaults every response to no-store, nosniff, no framing and no referrer', () => {
    expect(run(false)).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });
});
