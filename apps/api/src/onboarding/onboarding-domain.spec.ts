import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertCompletable,
  canMoveTask,
  dueDateOf,
  isOverdue,
  parseTemplateTask,
  parseWorkflowCode,
  permissionFamily,
  progressOf,
} from './onboarding-domain.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

function code(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { code: string })
      .code;
  }
  throw new Error('Expected a validation error.');
}

describe('onboarding domain', () => {
  it('normalizes template codes', () => {
    expect(parseWorkflowCode(' teacher-onboarding ')).toBe(
      'TEACHER-ONBOARDING',
    );
    expect(code(() => parseWorkflowCode('x'))).toBe('WORKFLOW_CODE_INVALID');
  });

  it('validates owner, acknowledgement and reference shapes of template tasks', () => {
    const base = {
      title: 'Task',
      category: 'OTHER',
      ownerType: 'EMPLOYEE' as const,
    };
    expect(parseTemplateTask(base)).toMatchObject({
      required: true,
      dueOffsetDays: 0,
      systemAction: 'NONE',
      ownerUserId: null,
    });
    expect(
      code(() => parseTemplateTask({ ...base, ownerType: 'SPECIFIC_USER' })),
    ).toBe('WORKFLOW_OWNER_INVALID');
    expect(code(() => parseTemplateTask({ ...base, ownerUserId: 'u-1' }))).toBe(
      'WORKFLOW_OWNER_INVALID',
    );
    expect(
      code(() => parseTemplateTask({ ...base, acknowledgementRequired: true })),
    ).toBe('WORKFLOW_ACKNOWLEDGEMENT_INVALID');
    expect(
      code(() =>
        parseTemplateTask({
          ...base,
          ownerType: 'HR',
          acknowledgementRequired: true,
          acknowledgementStatement: 'I read it',
        }),
      ),
    ).toBe('WORKFLOW_ACKNOWLEDGEMENT_INVALID');
    expect(
      code(() => parseTemplateTask({ ...base, referenceType: 'GOOGLE_FORM' })),
    ).toBe('WORKFLOW_REFERENCE_INVALID');
    expect(
      code(() =>
        parseTemplateTask({ ...base, referenceUrl: 'https://x.test' }),
      ),
    ).toBe('WORKFLOW_REFERENCE_INVALID');
    expect(
      code(() =>
        parseTemplateTask({
          ...base,
          referenceType: 'EXTERNAL_URL',
          referenceUrl: 'http://x.test',
        }),
      ),
    ).toBe('WORKFLOW_URL_INVALID');
    expect(code(() => parseTemplateTask({ ...base, dueOffsetDays: 400 }))).toBe(
      'WORKFLOW_OFFSET_INVALID',
    );
    expect(
      parseTemplateTask({
        ...base,
        referenceType: 'GOOGLE_FORM',
        referenceExternalId: 'form-1',
      }),
    ).toMatchObject({ referenceExternalId: 'form-1' });
  });

  it('computes due dates from the anchor and derives overdue from the date', () => {
    expect(dueDateOf(d('2026-04-01'), -3).toISOString().slice(0, 10)).toBe(
      '2026-03-29',
    );
    expect(
      isOverdue(
        { status: 'NOT_STARTED', dueDate: d('2026-03-14') },
        d('2026-03-15'),
      ),
    ).toBe(true);
    expect(
      isOverdue(
        { status: 'IN_PROGRESS', dueDate: d('2026-03-15') },
        d('2026-03-15'),
      ),
    ).toBe(false);
    expect(
      isOverdue(
        { status: 'COMPLETED', dueDate: d('2026-01-01') },
        d('2026-03-15'),
      ),
    ).toBe(false);
    expect(
      isOverdue({ status: 'NOT_STARTED', dueDate: null }, d('2026-03-15')),
    ).toBe(false);
  });

  it('mirrors the task lifecycle of the database guard', () => {
    expect(canMoveTask('NOT_STARTED', 'COMPLETED')).toBe(true);
    expect(canMoveTask('COMPLETED', 'IN_PROGRESS')).toBe(true);
    expect(canMoveTask('COMPLETED', 'WAIVED')).toBe(false);
    expect(canMoveTask('CANCELLED', 'IN_PROGRESS')).toBe(false);
    expect(canMoveTask('IN_PROGRESS', 'NOT_STARTED')).toBe(false);
  });

  it('measures progress over non-cancelled tasks', () => {
    const progress = progressOf(
      [
        { status: 'COMPLETED', required: true, dueDate: null },
        { status: 'WAIVED', required: true, dueDate: null },
        { status: 'NOT_STARTED', required: false, dueDate: d('2026-03-01') },
        { status: 'CANCELLED', required: true, dueDate: null },
      ],
      d('2026-03-15'),
    );
    expect(progress).toEqual({
      total: 3,
      done: 2,
      percent: 66,
      requiredTotal: 2,
      requiredDone: 2,
      overdue: 1,
      allDone: false,
      requiredComplete: true,
    });
    expect(progressOf([], d('2026-03-15')).percent).toBe(100);
  });

  it('requires acknowledgement and evidence where tasks say so', () => {
    expect(
      code(() =>
        assertCompletable(
          { acknowledgementRequired: true, evidenceRequired: false },
          { note: 'done', evidenceReference: null, acknowledging: false },
        ),
      ),
    ).toBe('WORKFLOW_ACKNOWLEDGEMENT_REQUIRED');
    expect(
      code(() =>
        assertCompletable(
          { acknowledgementRequired: false, evidenceRequired: true },
          { note: null, evidenceReference: null, acknowledging: false },
        ),
      ),
    ).toBe('WORKFLOW_EVIDENCE_REQUIRED');
    expect(() =>
      assertCompletable(
        { acknowledgementRequired: false, evidenceRequired: true },
        {
          note: null,
          evidenceReference: 'https://drive/x',
          acknowledging: false,
        },
      ),
    ).not.toThrow();
    expect(permissionFamily('OFFBOARDING')).toBe('offboarding');
  });
});
