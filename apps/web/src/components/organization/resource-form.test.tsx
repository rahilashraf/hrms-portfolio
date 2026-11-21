import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkLocation } from '../../lib/organization/types';
import {
  formInitialFromRecord,
  OrganizationResourceForm,
  type ResourceFormOptions,
} from './resource-form';

const options: ResourceFormOptions = {
  units: [],
  departments: [],
  teams: [],
  jobTitles: [],
  workLocations: [],
};

describe('OrganizationResourceForm', () => {
  afterEach(cleanup);
  it('shows backend validation errors in an accessible alert', () => {
    render(
      <OrganizationResourceForm
        kind="units"
        options={options}
        error="Business unit cannot be archived while active child records remain."
        busy={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Business unit cannot be archived while active child records remain.',
    );
  });

  it('shows only the selected Team placement selector', () => {
    render(
      <OrganizationResourceForm
        kind="teams"
        options={{
          ...options,
          departments: [
            {
              id: 'department-1',
              organizationId: 'organization-1',
              name: 'Teaching',
              code: 'TEACHING',
              description: null,
              sortOrder: 0,
              archivedAt: null,
              createdAt: '',
              updatedAt: '',
              organizationalUnitId: null,
            },
          ],
          units: [
            {
              id: 'unit-1',
              organizationId: 'organization-1',
              name: 'School',
              code: 'SCHOOL',
              description: null,
              sortOrder: 0,
              archivedAt: null,
              createdAt: '',
              updatedAt: '',
              parentUnitId: null,
            },
          ],
        }}
        error={null}
        busy={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Placement type'), {
      target: { value: 'units' },
    });

    expect(screen.getByLabelText('Business Unit')).toBeVisible();
    expect(screen.queryByLabelText('Department', { exact: true })).not.toBeInTheDocument();
  });

  it('renders controls read-only without a submit action', () => {
    render(
      <OrganizationResourceForm
        kind="units"
        options={options}
        initial={{ id: 'unit-1', name: 'School', code: 'SCHOOL', description: '', sortOrder: 0 }}
        error={null}
        busy={false}
        readOnly
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
  });

  const location = (id: string, siteId: string, siteName: string): WorkLocation => ({
    id,
    organizationId: 'organization-1',
    name: `Location ${id}`,
    code: id.toUpperCase(),
    description: null,
    sortOrder: 0,
    archivedAt: null,
    createdAt: '',
    updatedAt: '',
    physicalSiteId: siteId,
    physicalSite: { id: siteId, organizationId: 'organization-1', name: siteName },
    addressLine1: null,
    addressLine2: null,
    city: null,
    stateProvince: null,
    postalCode: null,
    country: null,
    timezone: 'America/Toronto',
  });

  it('keeps a work location on its physical site when it is edited', () => {
    const edited = location('loc-1', 'site-main', 'Main campus');
    const onSubmit = vi.fn();
    render(
      <OrganizationResourceForm
        kind="work-locations"
        initial={formInitialFromRecord('work-locations', edited)}
        // Even when no other active location shares the site, the edited one offers it.
        options={{ ...options, workLocations: [location('loc-2', 'site-north', 'North')] }}
        error={null}
        busy={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const site = screen.getByLabelText('Physical Site') as HTMLSelectElement;
    expect(site.value).toBe('site-main');
    expect(Array.from(site.options).map((option) => option.textContent)).toEqual([
      'Create a matching physical site',
      'North',
      'Main campus',
    ]);
    fireEvent.submit(site.form!);
    expect((onSubmit.mock.calls[0]![0] as FormData).get('physicalSiteId')).toBe('site-main');
  });

  it('Batch 5C: offers the organization’s physical sites and keeps the create option', () => {
    render(
      <OrganizationResourceForm
        kind="work-locations"
        options={{
          ...options,
          workLocations: [location('loc-2', 'site-north', 'North')],
          physicalSites: [
            { id: 'site-east', organizationId: 'organization-1', name: 'East building' },
            { id: 'site-west', organizationId: 'organization-1', name: 'West building' },
          ],
        }}
        error={null}
        busy={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const site = screen.getByLabelText('Physical Site') as HTMLSelectElement;
    // The listed sites replace the work-location fallback (a site with no location yet appears).
    expect(Array.from(site.options).map((option) => option.textContent)).toEqual([
      'Create a matching physical site',
      'East building',
      'West building',
    ]);
    expect(site.value).toBe('');
  });

  describe('Position references (R5B)', () => {
    const positionOptions: ResourceFormOptions = {
      ...options,
      // Organization lookups (empty for managers below the organization) …
      jobTitles: [],
      workLocations: [],
      // … and what the reference options route offers them.
      positionReferences: {
        jobTitles: [{ id: 'jt-1', name: 'Teacher', code: 'TEACHER' }],
        workLocations: [{ id: 'wl-1', name: 'Main campus', code: 'MAIN' }],
      },
    };
    const labels = (name: string) =>
      Array.from((screen.getByLabelText(name) as HTMLSelectElement).options).map(
        (option) => option.textContent,
      );

    it('offers the reference options for a new Position, with a required job title', () => {
      render(
        <OrganizationResourceForm
          kind="positions"
          options={positionOptions}
          error={null}
          busy={false}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Job Title')).toBeRequired();
      expect(labels('Job Title')).toEqual(['Select…', 'Teacher (TEACHER)']);
      expect(labels('Work Location')).toEqual(['No work location', 'Main campus (MAIN)']);
    });

    it('keeps the current, no longer offered job title and work location selected when editing', () => {
      const onSubmit = vi.fn();
      render(
        <OrganizationResourceForm
          kind="positions"
          options={positionOptions}
          initial={{
            id: 'pos-1',
            name: 'Teacher',
            code: 'T1',
            description: '',
            sortOrder: 0,
            jobTitleId: 'jt-archived',
            workLocationId: 'wl-archived',
            organizationalUnitId: null,
            departmentId: null,
            teamId: null,
          }}
          error={null}
          busy={false}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Job Title')).toHaveValue('jt-archived');
      expect(labels('Job Title')).toEqual([
        'Select…',
        'Teacher (TEACHER)',
        'Current job title (unavailable for new positions)',
      ]);
      expect(screen.getByLabelText('Work Location')).toHaveValue('wl-archived');
      expect(labels('Work Location')).toEqual([
        'No work location',
        'Main campus (MAIN)',
        'Current work location (unavailable for new positions)',
      ]);
      fireEvent.submit(screen.getByLabelText('Job Title').closest('form')!);
      const data = onSubmit.mock.calls[0]![0] as FormData;
      // Nothing is cleared silently: the submitted values are the current ones.
      expect(data.get('jobTitleId')).toBe('jt-archived');
      expect(data.get('workLocationId')).toBe('wl-archived');
    });
  });
});
