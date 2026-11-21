'use client';

import { useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, LoadingState } from '../organization/shared';
import { employeeApi } from '../../lib/employee/api';
import { formatDateOnly } from '../../lib/employee/date';
import { employeeErrorMessage } from '../../lib/employee/errors';
import { AuthApiError } from '../../lib/auth/types';
import type { MyAssignmentView, MyEmployeeProfile } from '../../lib/employee/types';
import {
  AssignmentStatusBadge,
  Detail,
  EmployeeStatusBadge,
  displayName,
  employmentTypeLabel,
} from './employee-shared';
import { PageContainer } from '../ui/page-container';

/**
 * Employee self-service: one's own employee record, read-only (GET /employees/me). The API
 * resolves the employee from the signed-in account, so no other employee can be requested.
 */
export function MyProfilePage() {
  const [profile, setProfile] = useState<MyEmployeeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEmployee, setNotEmployee] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      employeeApi
        .me()
        .then((value) => {
          if (active) setProfile(value);
        })
        .catch((cause) => {
          if (!active) return;
          if (cause instanceof AuthApiError && cause.status === 404) setNotEmployee(true);
          else setError(employeeErrorMessage(cause, 'Unable to load your profile.'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My profile"
        description="Your employee record and positions. Ask HR to correct anything that is out of date."
      />
      <div className="mt-8 space-y-6">
        {loading ? (
          <LoadingState />
        ) : notEmployee ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
            Your account is not linked to an employee record.
          </p>
        ) : error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : profile ? (
          <ProfileDetails profile={profile} />
        ) : null}
      </div>
    </PageContainer>
  );
}

function ProfileDetails({ profile }: { profile: MyEmployeeProfile }) {
  const { person } = profile;
  const fullName = [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');
  return (
    <>
      <section
        className="rounded-xl border border-slate-200 bg-white p-5"
        aria-label="Personal details"
      >
        <h2 className="text-lg font-semibold text-slate-950">{displayName(person)}</h2>
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {fullName && <Detail label="Legal name">{fullName}</Detail>}
          {person.preferredName && <Detail label="Preferred name">{person.preferredName}</Detail>}
          <Detail label="Employee number">{profile.employeeNumber}</Detail>
          <Detail label="Status">
            <EmployeeStatusBadge
              status={profile.status}
              terminationDate={profile.terminationDate}
            />
          </Detail>
          <Detail label="Hire date">{formatDateOnly(profile.hireDate)}</Detail>
          {profile.terminationDate && (
            <Detail label="Termination date">{formatDateOnly(profile.terminationDate)}</Detail>
          )}
          <Detail label="Personal email">{person.personalEmail ?? '—'}</Detail>
          <Detail label="Phone">{person.phone ?? '—'}</Detail>
        </dl>
      </section>
      <AssignmentGroup
        title="Current positions"
        items={profile.assignments.current}
        empty="No current position."
      />
      {profile.assignments.upcoming.length > 0 && (
        <AssignmentGroup title="Upcoming positions" items={profile.assignments.upcoming} />
      )}
      {profile.assignments.historical.length > 0 && (
        <AssignmentGroup title="Past positions" items={profile.assignments.historical} />
      )}
    </>
  );
}

function AssignmentGroup({
  title,
  items,
  empty,
}: {
  title: string;
  items: MyAssignmentView[];
  empty?: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label={title}>
      <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">{empty}</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {items.map((assignment) => (
            <li key={assignment.id} className="rounded-lg border border-slate-100 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{assignment.position.name}</span>
                <AssignmentStatusBadge status={assignment.status} />
                {assignment.isPrimary && (
                  <span className="text-xs font-medium text-indigo-700">Primary</span>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Job title">{assignment.jobTitle.name}</Detail>
                <Detail label="Organization">{assignment.organization.name}</Detail>
                <Detail label="Employment type">
                  {employmentTypeLabel(assignment.employmentType)}
                </Detail>
                <Detail label="Dates">
                  {formatDateOnly(assignment.startDate)} –{' '}
                  {assignment.endDate ? formatDateOnly(assignment.endDate) : 'ongoing'}
                </Detail>
                {assignment.placement && (
                  <Detail label="Placement">{assignment.placement.name}</Detail>
                )}
                {assignment.workLocation && (
                  <Detail label="Work location">{assignment.workLocation.name}</Detail>
                )}
                {assignment.manager && (
                  <Detail label="Manager">
                    {assignment.manager.displayName ?? 'Vacant'} ({assignment.manager.positionName})
                  </Detail>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
