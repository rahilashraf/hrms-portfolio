'use client';

import { useEffect, useState } from 'react';
import { onboardingErrorMessage } from '../../../lib/onboarding/errors';
import { LoadingText } from '../../ui/states';

// Batch 10E-1: shared by the onboarding administration sections (moved from
// onboarding-admin-page.tsx unchanged).
export type Mutate = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

/** Loads data for a tab; reloaded whenever `load` changes (or the tab remounts). */
export function useData<T>(load: () => Promise<T>, onError: (message: string) => void) {
  const [state, setState] = useState<{ data: T | null; loaded: boolean }>({
    data: null,
    loaded: false,
  });
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load()
        .then((data) => {
          if (active) setState({ data, loaded: true });
        })
        .catch((cause) => {
          if (!active) return;
          onError(onboardingErrorMessage(cause));
          setState({ data: null, loaded: true });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, onError]);
  return state;
}

export const Loading = LoadingText;
