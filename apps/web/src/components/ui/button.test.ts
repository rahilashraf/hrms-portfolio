import { describe, expect, it } from 'vitest';
import { buttonClass, type ButtonSize, type ButtonVariant } from './button';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'destructive', 'danger', 'ghost'];
const SIZES: ButtonSize[] = ['sm', 'md'];

describe('buttonClass (Batch 10E-2)', () => {
  it('never transitions opacity, so a button that becomes enabled is fully opaque at once', () => {
    for (const variant of VARIANTS)
      for (const size of SIZES) {
        const tokens = buttonClass(variant, size).split(/\s+/);
        // `transition` and `transition-all` include opacity; the explicit list must not.
        expect(tokens).not.toContain('transition');
        expect(tokens).not.toContain('transition-all');
        expect(tokens).not.toContain('transition-opacity');
        const property = tokens.find((token) => token.startsWith('transition-['));
        expect(property).toBe('transition-[color,background-color,border-color,box-shadow,filter]');
        expect(property).not.toMatch(/opacity/);
      }
  });

  it('keeps disabled buttons visibly distinct (60% opacity, not-allowed cursor)', () => {
    for (const variant of VARIANTS) {
      const tokens = buttonClass(variant).split(/\s+/);
      expect(tokens).toContain('disabled:opacity-60');
      expect(tokens).toContain('disabled:cursor-not-allowed');
    }
  });
});
