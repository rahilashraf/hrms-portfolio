import { AuthApiError } from '../auth/types';

export function organizationErrorMessage(
  error: unknown,
  fallback = 'The request could not be completed. Please try again.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 404) return 'The requested organization record was not found.';
  if (error.status === 409) return 'A record with this code already exists.';
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to perform this action.';
  if (error.status >= 500) return 'The organization service is temporarily unavailable.';
  return fallback;
}

/** Batch 5C: physical-site errors, with the domain codes explained. */
export function physicalSiteErrorMessage(
  error: unknown,
  fallback = 'Unable to save the physical site.',
): string {
  if (error instanceof AuthApiError) {
    const code = error.details?.code;
    if (code === 'PHYSICAL_SITE_IN_USE') {
      const locations = Number(error.details?.activeWorkLocations ?? 0);
      const devices = Number(error.details?.activeDevices ?? 0);
      return `This site is still in use (${locations} work location${locations === 1 ? '' : 's'}, ${devices} active kiosk device${devices === 1 ? '' : 's'}). Move or archive them first.`;
    }
    if (code === 'PHYSICAL_SITE_NAME_TAKEN')
      return 'Another active physical site in this organization already has this name.';
    if (code === 'ORGANIZATION_ARCHIVED') return 'The organization is archived.';
  }
  return organizationErrorMessage(error, fallback);
}
