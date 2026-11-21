'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { recruitmentErrorMessage } from '../../../lib/recruitment/errors';
import type { CandidateSource } from '../../../lib/recruitment/types';
import { LoadingText } from '../../ui/states';

// Batch 10E-1: shared by the recruitment administration sections (moved from
// recruitment-admin-page.tsx unchanged).
export const SOURCES: CandidateSource[] = [
  'DIRECT',
  'REFERRAL',
  'JOB_BOARD',
  'AGENCY',
  'INTERNAL',
  'CAREERS_SITE',
  'EXTERNAL_FORM',
  'OTHER',
];

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
          onError(recruitmentErrorMessage(cause));
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

export const appLink = (applicationId: string, text: string) => (
  <Link className="text-indigo-700 underline" href={`/recruitment/applications/${applicationId}`}>
    {text}
  </Link>
);
