'use client';

import { featureDisabledMessage } from '../../lib/features/errors';

/**
 * Explains that an area is switched off for the organization (a 403 FEATURE_DISABLED /
 * SETTING_DISABLED refusal). Renders nothing for any other error, so callers can place it next
 * to their own error handling: `<FeatureDisabledNotice error={error} />`.
 */
export function FeatureDisabledNotice({ error }: { error: unknown }) {
  const message = featureDisabledMessage(error);
  if (!message) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-medium">{message}</p>
      <p className="mt-1">
        An administrator can turn it back on under Settings &amp; features. Existing data is kept.
      </p>
    </div>
  );
}
