import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDocumentTitle } from './use-document-title';

function Title({ value }: { value: string }) {
  useDocumentTitle(value);
  return null;
}

/** What Next.js does after hydration: re-commit the layout's metadata title. */
function frameworkRewrite(text: string) {
  let element = document.head.querySelector('title');
  if (!element) {
    element = document.createElement('title');
    document.head.append(element);
  }
  element.textContent = text;
}

afterEach(() => {
  cleanup();
  document.title = '';
});

describe('useDocumentTitle', () => {
  it('sets the title and restores it when the framework rewrites it later', async () => {
    const view = render(<Title value="Sign in · HRMS" />);
    expect(document.title).toBe('Sign in · HRMS');

    // The branding arrives, then the metadata title is committed afterwards (the old race).
    view.rerender(<Title value="Sign in · Northwind" />);
    expect(document.title).toBe('Sign in · Northwind');
    frameworkRewrite('HRMS');
    await waitFor(() => expect(document.title).toBe('Sign in · Northwind'));

    // A replaced <title> element is handled too.
    document.head.querySelector('title')?.remove();
    frameworkRewrite('HRMS');
    await waitFor(() => expect(document.title).toBe('Sign in · Northwind'));
  });

  it('lets the most recently mounted owner win and hands back on unmount', async () => {
    const shell = render(<Title value="Home · Northwind" />);
    const page = render(<Title value="Payroll · Northwind" />);
    expect(document.title).toBe('Payroll · Northwind');
    frameworkRewrite('HRMS');
    await waitFor(() => expect(document.title).toBe('Payroll · Northwind'));

    page.unmount();
    expect(document.title).toBe('Home · Northwind');

    // Once nobody owns the title, it is left alone.
    shell.unmount();
    frameworkRewrite('HRMS');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.title).toBe('HRMS');
  });
});
