import { RoleDetailPage } from '../../../../../../../components/authorization/access-control';
export default async function Page({ params }: { params: Promise<{ roleId: string }> }) {
  return <RoleDetailPage roleId={(await params).roleId} />;
}
