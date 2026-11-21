import { zodResolver } from '@hookform/resolvers/zod';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from '../../../lib/forms/zod';
import { AuthApiError } from '../../../lib/auth/types';
import { applyApiErrors } from '../../../lib/forms/api-errors';
import { optionalText, requiredText } from '../../../lib/forms/schemas';
import { expectNoAxeViolations } from '../../../test/axe';
import { InlineMessage } from '../inline-message';
import { CheckboxField, InputField, SelectField, SubmitButton, TextareaField } from './form-field';

const schema = z.object({
  code: requiredText('a code', 40),
  name: requiredText('a name'),
  category: z.string(),
  notes: optionalText(500),
  active: z.boolean(),
});
type Values = z.input<typeof schema>;
type Parsed = z.output<typeof schema>;

function Harness({ submit }: { submit(values: Parsed): Promise<void> }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', name: '', category: 'A', notes: '', active: true },
  });
  return (
    <form
      aria-label="Example"
      noValidate
      onSubmit={handleSubmit(async (values) => {
        setFormError(null);
        try {
          await submit(values);
        } catch (cause) {
          const outcome = applyApiErrors(cause, setError, {
            fields: { code: 'code', name: 'name' },
            codes: { CODE_TAKEN: { field: 'code', message: 'That code is already used.' } },
          });
          if (outcome.placed === 0 || outcome.message)
            setFormError(outcome.message ?? 'Unable to save.');
        }
      })}
    >
      <InputField
        label="Code"
        required
        hint="Letters and numbers."
        error={errors.code?.message}
        registration={register('code')}
      />
      <InputField
        label="Name"
        required
        error={errors.name?.message}
        registration={register('name')}
      />
      <SelectField label="Category" registration={register('category')}>
        <option value="A">A</option>
        <option value="B">B</option>
      </SelectField>
      <TextareaField label="Notes" error={errors.notes?.message} registration={register('notes')} />
      <CheckboxField label="Active" registration={register('active')} />
      {formError && <InlineMessage tone="error">{formError}</InlineMessage>}
      <SubmitButton busy={isSubmitting}>Save</SubmitButton>
    </form>
  );
}

afterEach(cleanup);

describe('form fields', () => {
  it('ties labels, hints and errors to the controls and focuses the first invalid field', async () => {
    const submit = vi.fn();
    const { container } = render(<Harness submit={submit} />);
    const code = screen.getByLabelText(/^Code/);
    expect(code).toHaveAttribute('aria-required', 'true');
    expect(code).toHaveAccessibleDescription('Letters and numbers.');
    await expectNoAxeViolations(container);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a code.')).toBeInTheDocument();
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code).toHaveAccessibleDescription('Enter a code. Letters and numbers.');
    expect(screen.getByLabelText(/^Name/)).toHaveAccessibleDescription('Enter a name.');
    await waitFor(() => expect(code).toHaveFocus());
    expect(submit).not.toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('puts API validation messages and coded refusals on their fields, the rest on the form', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new AuthApiError('validation', 400, 'Name must be shorter.', {
          message: ['name must be shorter than or equal to 120 characters', 'colour is invalid'],
        }),
      )
      .mockRejectedValueOnce(new AuthApiError('conflict', 409, undefined, { code: 'CODE_TAKEN' }))
      .mockRejectedValueOnce(new AuthApiError('service-unavailable', 503));
    render(<Harness submit={submit} />);
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'OPS' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Operations' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Name must be shorter than or equal to 120 characters.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Colour is invalid.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That code is already used.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Code/)).toHaveAttribute('aria-invalid', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Unable to save.')).toBeInTheDocument();
  });

  it('disables the submit button while busy and shows progress', () => {
    render(
      <form>
        <SubmitButton busy busyLabel="Creating…">
          Create
        </SubmitButton>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Creating…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
