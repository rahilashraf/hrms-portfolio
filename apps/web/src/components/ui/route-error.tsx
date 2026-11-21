'use client';

import { useEffect } from 'react';
import { PageContainer, type PageWidth } from './page-container';
import { ErrorState, type StateAction } from './states';

export interface RouteErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

/**
 * Fallback for a route segment that threw while rendering (used by the `error.tsx` and
 * `global-error.tsx` boundaries). The raw error message is never shown, because it may carry
 * internal detail; the digest lets support match the failure to server logs.
 */
export function RouteErrorState({
  error,
  retry,
  home,
  width = 'default',
}: RouteErrorProps & {
  /** Where to go instead of retrying; omitted on the kiosk, which has nowhere else to go. */
  home?: StateAction;
  /** The frame of the page that failed, so the error replaces it in place. */
  width?: PageWidth;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer width={width}>
      <ErrorState
        title="This page couldn't be displayed"
        message={
          <>
            Something went wrong while showing this page. Try again, and contact your administrator
            if it keeps happening.
            {error.digest && (
              <span className="mt-2 block font-mono text-xs">Reference: {error.digest}</span>
            )}
          </>
        }
        onRetry={retry}
        action={home}
      />
    </PageContainer>
  );
}
