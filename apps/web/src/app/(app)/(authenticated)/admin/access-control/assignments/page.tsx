import { AssignmentsPage } from '../../../../../../components/authorization/access-control';
import { PageContainer } from '../../../../../../components/ui/page-container';
import { EmptyState } from '../../../../../../components/ui/states';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ roleId?: string }>;
}) {
  const roleId = (await searchParams).roleId;
  return roleId ? (
    <AssignmentsPage roleId={roleId} />
  ) : (
    <PageContainer width="wide">
      <EmptyState
        title="Select a role to manage user access."
        description="User access is granted per role. Open a role to see who holds it and add or revoke access."
        action={{ label: 'Open Roles & Permissions', href: '/admin/access-control/roles' }}
      />
    </PageContainer>
  );
}
