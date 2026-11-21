import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlField } from './form-field';

afterEach(() => cleanup());

describe('ControlField (Batch 10E-2)', () => {
  it('names a native control by its label and describes it by the hint', () => {
    const onChange = vi.fn();
    render(
      <ControlField label="Rate amount" hint="Per pay period, in the plan currency.">
        <input value="12.50" onChange={onChange} required />
      </ControlField>,
    );
    const input = screen.getByRole('textbox', { name: 'Rate amount' });
    expect(input).toHaveAccessibleDescription('Per pay period, in the plan currency.');
    // The control keeps its own value, attributes and handlers.
    expect(input).toHaveValue('12.50');
    expect(input).toBeRequired();
    fireEvent.change(input, { target: { value: '13.00' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves a control without a hint undescribed, and works for selects', () => {
    render(
      <ControlField label="Coverage">
        <select defaultValue="EMPLOYEE_ONLY">
          <option value="EMPLOYEE_ONLY">Employee only</option>
        </select>
      </ControlField>,
    );
    const select = screen.getByRole('combobox', { name: 'Coverage' });
    expect(select).not.toHaveAttribute('aria-describedby');
  });

  it("keeps the control's own description (e.g. its error) next to the hint", () => {
    render(
      <>
        <ControlField label="New code" hint="For example X-V2.">
          <input aria-describedby="copy-code-error" aria-invalid defaultValue="X" />
        </ControlField>
        <p id="copy-code-error">That code is already used.</p>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'New code' })).toHaveAccessibleDescription(
      'For example X-V2. That code is already used.',
    );
  });
});
