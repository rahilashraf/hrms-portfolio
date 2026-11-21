import { WorkflowPage } from '../../../../../../components/onboarding/workflow-page';

export default async function OnboardingWorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return <WorkflowPage workflowId={workflowId} />;
}
