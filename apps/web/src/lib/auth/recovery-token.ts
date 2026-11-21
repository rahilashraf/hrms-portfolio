export function readFragmentToken(): string | null {
  if (typeof window === 'undefined') return null;
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  return parameters.get('token');
}

export function removeTokenFragment(): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
}
