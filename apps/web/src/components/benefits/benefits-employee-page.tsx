'use client';

import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { benefitsApi } from '../../lib/benefits/api';
import { PageHeader } from '../organization/shared';
import { EmployeeBenefitsSection } from './employee-benefits-section';

/**
 * Batch 7C — an employee's benefits (elections and dependents) for benefits administrators and
 * readers, reached from the Benefits admin page: the employee profile needs employee.read,
 * which benefits roles do not get. The section itself enforces every permission through the API.
 */
export function BenefitsEmployeePage({ employeeId }: { employeeId: string }) {
  const [who, setWho] = useState<{ displayName: string; employeeNumber: string } | null>(null);
  useEffect(() => {
    let active = true;
    benefitsApi
      .employee(employeeId)
      .then((data) => active && setWho(data.employee ?? null))
      .catch(() => undefined); // The section below reports any failure.
    return () => {
      active = false;
    };
  }, [employeeId]);
  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Benefits"
        title={who ? `${who.displayName} — benefits` : 'Employee benefits'}
        description={who ? `Employee ${who.employeeNumber}` : undefined}
      >
        <Link className="text-sm font-medium text-indigo-700 underline" href="/admin/benefits">
          Back to Benefits
        </Link>
      </PageHeader>
      <div className="mt-6">
        <EmployeeBenefitsSection employeeId={employeeId} />
      </div>
    </PageContainer>
  );
}
