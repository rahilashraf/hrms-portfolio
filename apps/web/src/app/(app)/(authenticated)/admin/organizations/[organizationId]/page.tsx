import { OrganizationOverviewPage } from '../../../../../../components/organization/organization-overview';

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <OrganizationOverviewPage organizationId={organizationId} />;
}
