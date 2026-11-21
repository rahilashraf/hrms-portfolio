import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { ScheduleCalendar } from './schedule-calendar';

afterEach(cleanup);

describe('ScheduleCalendar accessibility', () => {
  it('shows a week as a list of named days whose buttons open the day', async () => {
    const onOpenDay = vi.fn();
    const { container } = render(
      <ScheduleCalendar
        view="week"
        anchor="2026-10-07"
        shifts={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenDay={onOpenDay}
      />,
    );
    const week = screen.getByRole('list', { name: 'Week' });
    const days = within(week).getAllByRole('listitem');
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveAccessibleName('Monday, Oct 5, 2026');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    fireEvent.click(within(days[2]!).getAllByRole('button')[0]!);
    expect(onOpenDay).toHaveBeenCalledWith('2026-10-07');
    await expectNoAxeViolations(container);
  });

  it('keeps the month weekday headings out of the accessibility tree', async () => {
    const { container } = render(
      <ScheduleCalendar
        view="month"
        anchor="2026-10-07"
        shifts={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenDay={vi.fn()}
      />,
    );
    const month = screen.getByRole('list', { name: 'Month' });
    expect(within(month).getAllByRole('listitem').length % 7).toBe(0);
    expect(
      screen.getByRole('button', { name: 'Open Thursday, Oct 1, 2026 (0 shifts)' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('marks holidays on their days, named in words, without changing the shifts (R4-A.6)', async () => {
    const holidays = [
      {
        date: '2026-10-12',
        name: 'Thanksgiving',
        kind: 'STATUTORY_HOLIDAY' as const,
        organizationId: 'o1',
      },
      {
        date: '2026-10-14',
        name: 'Pool maintenance',
        kind: 'CLOSURE' as const,
        organizationId: 'o1',
      },
    ];
    const { container } = render(
      <ScheduleCalendar
        view="week"
        anchor="2026-10-12"
        shifts={[]}
        holidays={holidays}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenDay={vi.fn()}
      />,
    );
    const days = within(screen.getByRole('list', { name: 'Week' })).getAllByRole('listitem');
    expect(days[0]).toHaveAccessibleName('Monday, Oct 12, 2026 (holiday: Thanksgiving)');
    expect(days[0]).toHaveTextContent('Holiday: Thanksgiving');
    expect(days[2]).toHaveTextContent('Closure: Pool maintenance');
    expect(days[1]).toHaveAccessibleName('Tuesday, Oct 13, 2026');
    await expectNoAxeViolations(container);
  });
});
