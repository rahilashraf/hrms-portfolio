export function getApiBaseUrl(
  value: string | undefined = process.env.NEXT_PUBLIC_API_URL,
  production = process.env.NODE_ENV === 'production',
): string {
  if (!value) {
    throw new Error('NEXT_PUBLIC_API_URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be a valid absolute URL');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    (production && parsed.protocol !== 'https:')
  ) {
    throw new Error('NEXT_PUBLIC_API_URL must be an HTTP(S) URL and use HTTPS in production');
  }

  return parsed.toString().replace(/\/+$/, '');
}
