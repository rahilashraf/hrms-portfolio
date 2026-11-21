import { describe, expect, it } from 'vitest';
import {
  createDepartmentPayload,
  createPositionPayload,
  createTeamPayload,
  updatePositionPayload,
  updateTeamPayload,
} from './payloads';

function teamData(placementType: string, id: string): FormData {
  const data = new FormData();
  data.set('name', 'Teaching');
  data.set('code', 'TEACHING');
  data.set('description', '');
  data.set('sortOrder', '0');
  data.set('placementType', placementType);
  data.set(placementType === 'units' ? 'organizationalUnitId' : 'departmentId', id);
  return data;
}

function positionData(placementType: string, id?: string): FormData {
  const data = new FormData();
  data.set('name', 'Teacher');
  data.set('code', 'TEACHER');
  data.set('description', '');
  data.set('sortOrder', '0');
  data.set('jobTitleId', 'job-title-id');
  data.set('placementType', placementType);
  if (id) {
    const key =
      placementType === 'units'
        ? 'organizationalUnitId'
        : placementType === 'departments'
          ? 'departmentId'
          : 'teamId';
    data.set(key, id);
  }
  return data;
}

describe('organization placement payloads', () => {
  it('allows a Department without a unit placement', () => {
    const data = new FormData();
    data.set('name', 'People Operations');
    data.set('code', 'PEOPLE');
    data.set('description', '');
    data.set('sortOrder', '0');

    const payload = createDepartmentPayload(data);

    expect(payload).not.toHaveProperty('organizationalUnitId');
  });

  it('submits exactly one non-empty Team anchor for create and move', () => {
    const departmentPayload = createTeamPayload(teamData('departments', 'dept-1'));
    const unitPayload = updateTeamPayload(teamData('units', 'unit-1'));

    expect(departmentPayload).toMatchObject({ departmentId: 'dept-1' });
    expect('organizationalUnitId' in departmentPayload).toBe(false);
    expect(unitPayload).toMatchObject({ organizationalUnitId: 'unit-1' });
    expect('departmentId' in unitPayload).toBe(false);
  });

  it.each([
    ['organization', undefined, {}],
    ['units', 'unit-1', { organizationalUnitId: 'unit-1' }],
    ['departments', 'department-1', { departmentId: 'department-1' }],
    ['teams', 'team-1', { teamId: 'team-1' }],
  ])('creates a Position at %s scope with no conflicting anchor', (type, id, anchor) => {
    const payload = createPositionPayload(positionData(type, id));
    expect(payload).toMatchObject(anchor);
    expect(
      [payload.organizationalUnitId, payload.departmentId, payload.teamId].filter(Boolean),
    ).toHaveLength(id ? 1 : 0);
  });

  it('clears the previous Position placement when moving to organization scope', () => {
    const payload = updatePositionPayload(positionData('organization'), {
      jobTitleId: 'job-title-id',
      workLocationId: null,
    });

    expect(payload).toMatchObject({
      organizationalUnitId: null,
      departmentId: null,
      teamId: null,
    });
  });
});

/**
 * R5B: a Position referenced by employment history refuses any request that names an identity
 * field (job title, work location, placement), even with its current value. An edit therefore
 * sends only the identity fields the user actually changed.
 */
describe('Position update identity fields (R5B)', () => {
  const staffed = {
    jobTitleId: 'job-title-id',
    workLocationId: 'location-1',
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
  };

  function editData(changes: Record<string, string> = {}): FormData {
    const data = positionData('organization');
    data.set('workLocationId', 'location-1');
    for (const [key, value] of Object.entries(changes)) data.set(key, value);
    return data;
  }

  it('omits an unchanged job title and work location', () => {
    const payload = updatePositionPayload(editData({ name: 'Senior Teacher' }), staffed);

    expect(payload).toMatchObject({ name: 'Senior Teacher' });
    expect(payload).not.toHaveProperty('jobTitleId');
    expect(payload).not.toHaveProperty('workLocationId');
  });

  it('never sends a null work location the record does not have', () => {
    const data = editData();
    data.set('workLocationId', '');
    const payload = updatePositionPayload(data, { ...staffed, workLocationId: null });

    expect(payload).not.toHaveProperty('workLocationId');
    expect(payload).not.toHaveProperty('jobTitleId');
  });

  it('sends a changed job title or work location', () => {
    expect(updatePositionPayload(editData({ jobTitleId: 'job-title-2' }), staffed)).toMatchObject({
      jobTitleId: 'job-title-2',
    });
    const moved = updatePositionPayload(editData({ workLocationId: 'location-2' }), staffed);
    expect(moved).toMatchObject({ workLocationId: 'location-2' });
    expect(moved).not.toHaveProperty('jobTitleId');
  });

  it('sends null only when the user cleared a work location that was set', () => {
    const payload = updatePositionPayload(editData({ workLocationId: '' }), staffed);

    expect(payload).toHaveProperty('workLocationId', null);
    expect(payload).not.toHaveProperty('jobTitleId');
  });
});
