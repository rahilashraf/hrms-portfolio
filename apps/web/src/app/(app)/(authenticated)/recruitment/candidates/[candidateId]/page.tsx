import { CandidatePage } from '../../../../../../components/recruitment/candidate-page';

export default async function RecruitmentCandidatePage({
  params,
}: {
  params: Promise<{ candidateId: string }>;
}) {
  const { candidateId } = await params;
  return <CandidatePage candidateId={candidateId} />;
}
