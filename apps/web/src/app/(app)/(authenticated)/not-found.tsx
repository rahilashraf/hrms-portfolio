'use client';

import { usePathname } from 'next/navigation';
import { PageContainer } from '../../../components/ui/page-container';
import { NotFoundState } from '../../../components/ui/not-found-state';
import { pageWidthFor } from '../../../lib/navigation/page-width';

/**
 * Rendered inside the application shell when a page calls `notFound()`. Batch 10F: in the
 * route's page width (as the skeleton and the denied state), the card itself stays centred.
 */
export default function AuthenticatedNotFound() {
  return (
    <PageContainer width={pageWidthFor(usePathname())} padded={false}>
      <NotFoundState />
    </PageContainer>
  );
}
