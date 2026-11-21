import { ReviewPage } from '../../../../../../components/performance/review-page';

export default async function PerformanceReviewPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  return <ReviewPage reviewId={reviewId} />;
}
