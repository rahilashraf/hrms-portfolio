/** The local development port; production always receives PORT from the platform. */
export const DEVELOPMENT_PORT = 3001;

/**
 * The port the API listens on: PORT when set (Railway injects it), else 3001 outside
 * production. Production without PORT fails at startup instead of guessing a port the
 * platform's proxy and healthcheck would not reach.
 */
export function resolveListenPort(
  raw: string | undefined,
  production: boolean,
): number {
  if (raw === undefined || raw.trim() === '') {
    if (production) {
      throw new Error('PORT must be configured in production');
    }
    return DEVELOPMENT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}
