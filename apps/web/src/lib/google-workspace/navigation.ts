import { isGoogleAuthorizationUrl } from './domain';

/** The browser navigation used by the OAuth start (replaceable in tests). */
export const browserNavigation = {
  assign(url: string) {
    window.location.assign(url);
  },
};

/**
 * Leaves the app for Google's consent screen — only when the URL's origin is exactly
 * https://accounts.google.com. Returns whether it navigated.
 */
export function navigateToGoogleAuthorization(url: unknown): boolean {
  if (!isGoogleAuthorizationUrl(url)) return false;
  browserNavigation.assign(url);
  return true;
}
