import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Forbidden } from './forbidden';

describe('Forbidden', () => {
  it('renders an access-denied response with a safe recovery link', () => {
    render(<Forbidden />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return to dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });
});
