'use client';

import { lifecycleSteps, Stepper } from '../../ui/stepper';
import { useLocationChangeNotifier } from '../../../lib/navigation/use-location-hash';
import Link from 'next/link';
import type { ReviewDetail } from '../../../lib/performance/types';

// Batch 10E-2: moved from review-page.tsx unchanged.
/** The real ReviewStatus path; CLOSED (closed incomplete) is terminal and off it. */
const REVIEW_LIFECYCLE = [
  { key: 'NOT_STARTED', label: 'Not started' },
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'FINALIZED', label: 'Finalized' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged' },
] as const;

export function ReviewJourney({ review }: { review: ReviewDetail }) {
  // Same-page workflow links: re-read the URL once the router commits it (owned watcher).
  const notifyLocationChange = useLocationChangeNotifier();
  const hrView = review.viewer === 'HR' || review.viewer === 'READER';
  const links = [
    hrView
      ? { href: '/admin/performance#cycles', text: `Cycle: ${review.cycle.name}` }
      : { href: '/performance', text: `Cycle: ${review.cycle.name}` },
    { href: '#goals', text: 'Goals' },
    { href: '#results', text: 'Results' },
  ];
  return (
    <section
      aria-label="Review progress"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <Stepper
        label="Review status"
        steps={lifecycleSteps<string>(REVIEW_LIFECYCLE, review.status, {
          completeAtEnd: true,
          reached: 'NOT_STARTED',
        })}
      />
      <nav aria-label="Review workflow">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={notifyLocationChange}
                className="text-indigo-700 hover:underline"
              >
                {link.text}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
