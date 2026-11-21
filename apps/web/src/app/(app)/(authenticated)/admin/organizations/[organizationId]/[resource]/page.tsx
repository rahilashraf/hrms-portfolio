import { notFound } from 'next/navigation';
import { OrganizationResourcePage } from '../../../../../../../components/organization/resource-page';
import type { ResourceKind } from '../../../../../../../components/organization/resource-form';

const resources: ResourceKind[] = [
  'units',
  'departments',
  'teams',
  'job-titles',
  'positions',
  'work-locations',
];

function isResourceKind(value: string): value is ResourceKind {
  return resources.some((resource) => resource === value);
}

export default async function OrganizationResourceRoute({
  params,
}: {
  params: Promise<{ organizationId: string; resource: string }>;
}) {
  const { organizationId, resource } = await params;
  if (!isResourceKind(resource)) notFound();
  return <OrganizationResourcePage organizationId={organizationId} resource={resource} />;
}
