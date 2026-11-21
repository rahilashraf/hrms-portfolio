import { EmployeeProfilePage } from '../../../../../../components/employee/employee-profile';

export default async function EmployeePage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;
  return <EmployeeProfilePage employeeId={employeeId} />;
}
