'use client';

import { useEffect } from 'react';

/**
 * Batch 3B — while a long form has unsaved changes, leaving or reloading the page asks the
 * browser's own "leave site?" question. Use on long forms only (offers, templates, reviews…).
 */
export function useUnsavedChangesWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need returnValue set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
