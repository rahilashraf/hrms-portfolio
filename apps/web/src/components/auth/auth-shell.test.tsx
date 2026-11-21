import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { authSubmitButtonClass, SubmitButton } from './auth-shell';

afterEach(cleanup);

describe('SubmitButton (Batch 10F)', () => {
  it('never transitions opacity, so a re-enabled button is fully opaque at once', () => {
    const tokens = authSubmitButtonClass.split(/\s+/);
    expect(tokens).not.toContain('transition');
    expect(tokens).not.toContain('transition-all');
    expect(tokens).not.toContain('transition-opacity');
    const transition = tokens.find((token) => token.startsWith('transition-['));
    expect(transition).toBe('transition-[color,background-color,border-color,box-shadow,filter]');
    expect(transition).not.toContain('opacity');
  });

  it('keeps disabled and submitting feedback', () => {
    expect(authSubmitButtonClass).toContain('disabled:opacity-60');
    expect(authSubmitButtonClass).toContain('disabled:cursor-wait');
  });

  it('is disabled and says "Please wait…" while submitting, then enables with its label', () => {
    const { rerender } = render(<SubmitButton busy>Sign in</SubmitButton>);
    const busy = screen.getByRole('button', { name: 'Please wait…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('type', 'submit');

    rerender(<SubmitButton busy={false}>Sign in</SubmitButton>);
    const enabled = screen.getByRole('button', { name: 'Sign in' });
    expect(enabled).toBeEnabled();
    expect(enabled.className).toBe(authSubmitButtonClass);
  });
});
