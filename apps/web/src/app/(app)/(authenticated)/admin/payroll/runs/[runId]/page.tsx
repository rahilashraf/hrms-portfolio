import { PayrollRunPage } from '../../../../../../../components/payroll/payroll-run-page';

export default async function AdminPayrollRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <PayrollRunPage runId={runId} />;
}
