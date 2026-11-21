import { describe, expect, it } from 'vitest';
import * as attendanceAdmin from './attendance-admin';
import { localDateTimeIn } from './admin/attendance-shared';
import * as timesheetReview from './review/timesheet-review';
import { TimesheetDetail } from './review/timesheet-detail';

/**
 * Batch 10C — `attendance-admin.tsx` and `review/timesheet-review.tsx` were split into panel
 * files (pure moves). Their old module paths still export the same functions, so every existing
 * import keeps working.
 */
describe('Batch 10C extractions keep the old import paths', () => {
  it('attendance-admin re-exports the moved helper and keeps its own exports', () => {
    expect(attendanceAdmin.localDateTimeIn).toBe(localDateTimeIn);
    expect(typeof attendanceAdmin.AttendanceAdmin).toBe('function');
    expect(typeof attendanceAdmin.attendanceSummary).toBe('function');
    expect(typeof attendanceAdmin.clockSections).toBe('function');
  });

  it('timesheet-review re-exports the timesheet detail', () => {
    expect(timesheetReview.TimesheetDetail).toBe(TimesheetDetail);
    expect(typeof timesheetReview.TimesheetReview).toBe('function');
  });
});
