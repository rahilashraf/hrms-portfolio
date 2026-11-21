'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { benefitOptionSource } from '../../../lib/benefits/pickers';
import { RecordCombobox } from '../../ui/record-combobox';

/**
 * Batch 7C — opens an employee's benefits (elections and dependents) by name, through the
 * Benefits pickers: benefits roles need no employee.read to find the people they administer.
 */
export function FindEmployee({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const source = useMemo(() => benefitOptionSource(organizationId, 'employee'), [organizationId]);
  return (
    <section aria-labelledby="benefits-find-employee" className="max-w-xl space-y-1">
      <h2 id="benefits-find-employee" className="text-sm font-semibold text-slate-900">
        Employee benefits
      </h2>
      <RecordCombobox
        key={organizationId}
        label="Find an employee"
        hint="Opens their elections and dependents."
        source={source}
        value=""
        onChange={(id) => {
          if (id) router.push(`/admin/benefits/employees/${encodeURIComponent(id)}`);
        }}
        placeholder="Name or employee number"
      />
    </section>
  );
}
