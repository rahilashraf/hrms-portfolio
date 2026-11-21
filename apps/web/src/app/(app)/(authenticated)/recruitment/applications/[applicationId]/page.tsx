import { ApplicationPage } from '../../../../../../components/recruitment/application-page';

export default async function RecruitmentApplicationPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const { applicationId } = await params;
  return <ApplicationPage applicationId={applicationId} />;
}
