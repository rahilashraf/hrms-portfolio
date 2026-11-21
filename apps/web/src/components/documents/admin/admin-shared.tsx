'use client';

import { useEffect, useState } from 'react';
import { documentsErrorMessage } from '../../../lib/documents/errors';
import { LoadingText } from '../../ui/states';

// Batch 10E-2: shared by the documents administration sections (moved from
// documents-admin-page.tsx unchanged).
export type Mutate = (
  action: () => Promise<unknown>,
  message: string | ((result: unknown) => string),
) => Promise<boolean>;

/** Loads data for a tab; reloaded whenever `load` changes (or the tab remounts). */
export function useData<T>(
  load: () => Promise<T>,
  onError: (message: string) => void,
  reloadKey: unknown = null,
) {
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
          onError(documentsErrorMessage(cause));
          setState({ data: null, loaded: true });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, onError, reloadKey]);
  return state;
}

export const Loading = LoadingText;

export const yes = (value: boolean) => (value ? 'Yes' : 'No');

// Batch 10E-2: the shared 24 px checkbox (was 16 px).
export { checkboxClass as checkbox } from '../../ui/tokens';
