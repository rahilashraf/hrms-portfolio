'use client';

import type { FormEvent } from 'react';
import { useCallback, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import type {
  AttendanceDevice,
  AttendanceOrganization,
  DeviceEnrollment,
} from '../../../lib/attendance/types';
import { formatInstant } from '../../../lib/time/format';
import { StatusPill } from '../employee-time-page';
import { useConfirm } from '../../ui/use-confirm';
import { inputClass, primaryButton } from '../../ui/tokens';
import {
  Empty,
  Feedback,
  Section,
  dangerButton,
  secondaryButton,
  usePanel,
} from './attendance-shared';

// Batch 10C: moved from attendance-admin.tsx unchanged. Kiosk registration, enrollment and
// revocation call the same API as before; nothing about device trust changed.
// ─── Kiosks ──────────────────────────────────────────────────────────────────

export function KiosksPanel({ organization }: { organization: AttendanceOrganization }) {
  const load = useCallback(
    () => attendanceApi.devices(organization.id).then((result) => result.items),
    [organization.id],
  );
  const { data, error, success, busy, mutate } = usePanel(load);
  const [enrollment, setEnrollment] = useState<DeviceEnrollment | null>(null);
  const [revoking, setRevoking] = useState<AttendanceDevice | null>(null);
  const [renaming, setRenaming] = useState<AttendanceDevice | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const sites = organization.physicalSites;

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    void mutate(
      'register',
      () =>
        attendanceApi.registerDevice({
          organizationId: organization.id,
          physicalSiteId: String(form.get('physicalSiteId') ?? ''),
          name: String(form.get('name') ?? '').trim(),
        }),
      'Kiosk registered. Enroll it with the code below.',
    ).then((result) => {
      if (result) {
        setEnrollment(result);
        formElement.reset();
      }
    });
  }

  function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revoking) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    void mutate(
      `revoke-${revoking.id}`,
      () => attendanceApi.revokeDevice(revoking.id, reason),
      'Kiosk revoked.',
    ).then((result) => {
      if (result) setRevoking(null);
    });
  }

  /** Batch 4E-2: rename a kiosk or move it to another site (audited by the API). */
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const physicalSiteId = String(form.get('physicalSiteId') ?? '');
    const changes = {
      ...(name !== renaming.name ? { name } : {}),
      ...(physicalSiteId && physicalSiteId !== renaming.physicalSite.id ? { physicalSiteId } : {}),
    };
    if (Object.keys(changes).length === 0) {
      setRenaming(null);
      return;
    }
    void mutate(
      `rename-${renaming.id}`,
      () => attendanceApi.updateDevice(renaming.id, changes),
      'Kiosk updated.',
    ).then((result) => {
      if (result) setRenaming(null);
    });
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      <Section title="Register a kiosk">
        {sites.length === 0 ? (
          <Empty>Add a physical site before registering a kiosk.</Empty>
        ) : (
          <form
            onSubmit={register}
            aria-label="Register kiosk"
            className="grid gap-3 md:grid-cols-3"
          >
            <label className="text-sm font-medium text-slate-700">
              Name
              <input
                name="name"
                required
                maxLength={120}
                placeholder="Front desk"
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Physical site
              <select name="physicalSiteId" required className={inputClass}>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button type="submit" disabled={busy !== null} className={primaryButton}>
                Register kiosk
              </button>
            </div>
          </form>
        )}
      </Section>
      {enrollment && (
        <section
          aria-label="Enrollment code"
          className="rounded-xl border border-indigo-200 bg-indigo-50 p-5 text-sm text-indigo-950"
        >
          <p className="font-semibold">Enrollment code for {enrollment.device.name}</p>
          <p className="mt-2 font-mono text-2xl tracking-widest" data-testid="enrollment-code">
            {enrollment.enrollment.code}
          </p>
          <p className="mt-2">
            Open <span className="font-mono">/kiosk</span> on the device and enter this code before{' '}
            {formatInstant(enrollment.enrollment.expiresAt, organization.timezone)}. It is shown
            only once and works once.
          </p>
          <button
            type="button"
            className={`${secondaryButton} mt-3 bg-white`}
            onClick={() => setEnrollment(null)}
          >
            Done
          </button>
        </section>
      )}
      <Section title="Kiosks">
        <div className="space-y-4">
          <Feedback error={error} success={success} />
          {data === null ? (
            <p role="status" className="text-sm text-slate-600">
              Loading kiosks…
            </p>
          ) : data.length === 0 ? (
            <Empty>No kiosks registered.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {data.map((device) => (
                <li
                  key={device.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div>
                    <p className="font-medium text-slate-900">{device.name}</p>
                    <p className="text-sm text-slate-600">
                      {device.physicalSite.name ?? 'Unknown site'} ·{' '}
                      {device.enrolled
                        ? `last seen ${formatInstant(device.lastSeenAt, organization.timezone)}`
                        : device.enrollmentPending
                          ? 'awaiting enrollment'
                          : 'not enrolled'}
                      {device.revokedReason && ` · ${device.revokedReason}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill value={device.status} />
                    {device.status !== 'REVOKED' && (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null}
                          className={secondaryButton}
                          onClick={async () => {
                            if (
                              !(await confirm({
                                title: `Issue a new enrollment code for ${device.name}?`,
                                description:
                                  'The kiosk stops working until it is enrolled again with the new code. Employees cannot clock in on it meanwhile.',
                                confirmLabel: 'Issue new code',
                              }))
                            )
                              return;
                            void mutate(
                              `rotate-${device.id}`,
                              () => attendanceApi.rotateDevice(device.id),
                              'New enrollment code issued; the kiosk must enroll again.',
                            ).then((result) => {
                              if (result) setEnrollment(result);
                            });
                          }}
                        >
                          New enrollment code
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          className={secondaryButton}
                          onClick={async () => {
                            // Disabling stops clock-ins at a site: confirmed. Enabling is not.
                            if (
                              device.status === 'ACTIVE' &&
                              !(await confirm({
                                title: `Disable ${device.name}?`,
                                description:
                                  'Employees cannot clock in or out on this kiosk until it is enabled again. Its enrollment is kept.',
                                confirmLabel: 'Disable kiosk',
                              }))
                            )
                              return;
                            void mutate(
                              `toggle-${device.id}`,
                              () =>
                                attendanceApi.setDeviceEnabled(
                                  device.id,
                                  device.status !== 'ACTIVE',
                                ),
                              device.status === 'ACTIVE' ? 'Kiosk disabled.' : 'Kiosk enabled.',
                            );
                          }}
                        >
                          {device.status === 'ACTIVE' ? 'Disable' : 'Enable'}{' '}
                          <span className="sr-only">{device.name}</span>
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          className={secondaryButton}
                          onClick={() => setRenaming(device)}
                        >
                          Rename or move <span className="sr-only">{device.name}</span>
                        </button>
                        <button
                          type="button"
                          className={dangerButton}
                          onClick={() => setRevoking(device)}
                        >
                          Revoke <span className="sr-only">{device.name}</span>
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {renaming && (
            <form
              onSubmit={rename}
              aria-label="Rename or move kiosk"
              className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 md:grid-cols-3"
            >
              <p className="text-sm text-slate-700 md:col-span-3">
                Rename <strong>{renaming.name}</strong> or move it to another site. Its enrollment,
                sessions and history are kept; the change is recorded in the audit log.
              </p>
              <label className="text-sm font-medium text-slate-700">
                Name
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={renaming.name}
                  className={inputClass}
                />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Site
                <select
                  name="physicalSiteId"
                  defaultValue={renaming.physicalSite.id}
                  className={inputClass}
                >
                  {!organization.physicalSites.some(
                    (site) => site.id === renaming.physicalSite.id,
                  ) && (
                    <option value={renaming.physicalSite.id}>
                      {renaming.physicalSite.name ?? 'Current site'}
                    </option>
                  )}
                  {organization.physicalSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <button type="submit" disabled={busy !== null} className={primaryButton}>
                  Save kiosk
                </button>
                <button type="button" className={secondaryButton} onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {revoking && (
            <form
              onSubmit={revoke}
              aria-label="Revoke kiosk"
              className="grid gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 md:grid-cols-3"
            >
              <p className="text-sm text-rose-900 md:col-span-3">
                Revoking <strong>{revoking.name}</strong> is permanent: it can no longer record
                attendance or enroll again. Its past records are kept.
              </p>
              <label className="text-sm font-medium text-slate-700 md:col-span-2">
                Reason
                <input name="reason" required className={inputClass} />
              </label>
              <div className="flex items-end gap-2">
                <button type="submit" disabled={busy !== null} className={dangerButton}>
                  Revoke kiosk
                </button>
                <button type="button" className={secondaryButton} onClick={() => setRevoking(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </Section>
    </div>
  );
}
