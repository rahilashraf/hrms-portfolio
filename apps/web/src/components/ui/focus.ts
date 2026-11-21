const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true',
  );
}

/** Keeps Tab / Shift+Tab inside `container`. Returns true when it handled the key. */
export function trapTab(
  event: { key: string; shiftKey: boolean; preventDefault(): void },
  container: HTMLElement,
): boolean {
  if (event.key !== 'Tab') return false;
  const items = focusableWithin(container);
  if (items.length === 0) {
    event.preventDefault();
    return true;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Batch 11C — returns focus after a dialog closes: to the element that had it (normally the
 * trigger) when it is still in the page and can take focus, else to the page's main region, so
 * keyboard and screen-reader users are never left on <body> when the action removed or disabled
 * its own trigger (an approved run's Approve button, a deleted row's Delete button).
 */
export function restoreFocus(previous: HTMLElement | null) {
  if (
    previous?.isConnected &&
    !(previous as HTMLButtonElement).disabled &&
    !previous.closest('[inert]')
  ) {
    previous.focus();
    if (document.activeElement === previous) return;
  }
  document.getElementById('main-content')?.focus();
}

/** After an async action re-rendered the page: if focus fell to <body>, move it to main. */
export function keepFocusInPage() {
  if (!document.activeElement || document.activeElement === document.body)
    document.getElementById('main-content')?.focus();
}
