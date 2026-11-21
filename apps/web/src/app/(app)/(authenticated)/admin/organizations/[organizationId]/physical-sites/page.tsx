import { PhysicalSitesPage } from '../../../../../../../components/organization/physical-sites-page';

export default async function PhysicalSitesRoute({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  return <PhysicalSitesPage organizationId={organizationId} />;
}
