import type { ElementType, ReactNode } from 'react';

/**
 * Batch 10A — the page's outer frame: centred, padded, one of four widths. Pages render the same
 * container while loading, while access is being checked and once loaded, so the content never
 * jumps between widths.
 *
 * - `narrow` (max-w-3xl): a single form or a settings page.
 * - `default` (max-w-5xl): most pages.
 * - `wide` (max-w-6xl): tables with many columns, dashboards.
 * - `full` (max-w-7xl): calendars and other dense layouts.
 */
export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

const WIDTHS: Record<PageWidth, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-5xl',
  wide: 'max-w-6xl',
  full: 'max-w-7xl',
};

/** The container's classes, for the few places that cannot render the component. */
export function pageContainerClass(width: PageWidth = 'default', padded = true): string {
  return `mx-auto w-full ${WIDTHS[width]} px-5${padded ? ' py-10' : ''}`;
}

export function PageContainer({
  width = 'default',
  as: Tag = 'div',
  padded = true,
  className,
  children,
}: {
  width?: PageWidth;
  /** Vertical padding (`py-10`); off for content that brings its own (e.g. the denied state). */
  padded?: boolean;
  /** The element to render (a `section` or `article` where that is the right landmark). */
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={
        className
          ? `${pageContainerClass(width, padded)} ${className}`
          : pageContainerClass(width, padded)
      }
    >
      {children}
    </Tag>
  );
}
