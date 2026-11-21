'use client';

import { useCallback, useEffect, useState } from 'react';
import { leaveErrorMessage } from '../../lib/leave/errors';
import { organizationApi } from '../../lib/organization/api';
import type { Department, OrganizationalUnit, Team } from '../../lib/organization/types';

// Batch 10B: shared by the leave configuration panels (moved from leave-config-panels.tsx).
/** Shared load/mutate state of a configuration panel. */
export function usePanel<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setData(await loader());
  }, [loader]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      loader()
        .then((value) => {
          if (!active) return;
          setData(value);
          setError(null);
        })
        .catch((cause) => active && setError(leaveErrorMessage(cause)));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loader]);

  async function mutate(key: string, action: () => Promise<unknown>, message: string) {
    if (busy) return false;
    setBusy(key);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await reload();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(leaveErrorMessage(cause, 'Unable to save this leave setting.'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { data, error, success, busy, mutate, setError };
}

/** Units, departments and teams for scope pickers; empty when the actor cannot read them. */
export function useStructure(organizationId: string) {
  const [structure, setStructure] = useState<{
    units: OrganizationalUnit[];
    departments: Department[];
    teams: Team[];
  }>({
    units: [],
    departments: [],
    teams: [],
  });
  useEffect(() => {
    let active = true;
    Promise.all([
      organizationApi.listUnits(organizationId).catch(() => []),
      organizationApi.listDepartments(organizationId).catch(() => []),
      organizationApi.listTeams(organizationId).catch(() => []),
    ]).then(([units, departments, teams]) => {
      if (active) setStructure({ units, departments, teams });
    });
    return () => {
      active = false;
    };
  }, [organizationId]);
  return structure;
}

export function value(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim();
}
