import { BenefitsEmployeePage } from '../../../../../../../components/benefits/benefits-employee-page';

/** Batch 7C: an employee's benefits for benefits administrators (no employee.read needed). */
export default async function AdminBenefitsEmployeePage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;
  return <BenefitsEmployeePage employeeId={employeeId} />;
}
