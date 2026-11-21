'use client';

import { usePathname } from 'next/navigation';
import { pageWidthFor } from '../../../lib/navigation/page-width';
import { PageContainer } from '../../../components/ui/page-container';
import { LoadingState } from '../../../components/ui/states';

/**
 * Route-level loading skeleton shown inside the shell while a page segment loads. It renders in
 * the destination page's own `PageContainer` width (Batch 10F), so the frame does not jump when
 * the page replaces it.
 */
export default function AuthenticatedLoading() {
  const pathname = usePathname();
  return (
    <PageContainer width={pageWidthFor(pathname)}>
      <LoadingState label="Loading page…" rows={5} />
    </PageContainer>
  );
}
