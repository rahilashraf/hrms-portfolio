'use client';

import { useEffect } from 'react';

/** Mounted title owners, most recent last; only the last one's title is applied. */
const owners: Array<{ title: string }> = [];
let observer: MutationObserver | null = null;

function apply() {
  const owner = owners.at(-1);
  // Only write when different, so the observer's own write does not loop.
  if (owner && document.title !== owner.title) document.title = owner.title;
}

/**
 * Sets the browser tab title while the component is mounted, and keeps it: Next.js commits
 * the layout's metadata `<title>` ("HRMS") after hydration, which used to overwrite a title set
 * once in an effect (the login branding title then read "HRMS"). Any later rewrite of the
 * document title re-applies this one. When several components own the title (nested pages),
 * the most recently mounted wins; when it unmounts, the previous owner's title returns.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const owner = { title };
    owners.push(owner);
    if (!observer) {
      observer = new MutationObserver(apply);
      observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    }
    apply();
    return () => {
      owners.splice(owners.indexOf(owner), 1);
      if (owners.length === 0) {
        observer?.disconnect();
        observer = null;
      } else {
        apply();
      }
    };
  }, [title]);
}
