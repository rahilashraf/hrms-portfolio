'use client';

import { lifecycleSteps, Stepper, type Step } from '../../ui/stepper';
import { useLocationChangeNotifier } from '../../../lib/navigation/use-location-hash';
import Link from 'next/link';
import type { ApplicationDetail } from '../../../lib/recruitment/types';

// Batch 10E-1: moved from application-page.tsx unchanged.
const JOURNEY = [
  { key: 'APPLICATION', label: 'Application' },
  { key: 'INTERVIEWS', label: 'Interviews' },
  { key: 'OFFER', label: 'Offer' },
  { key: 'HIRE', label: 'Hire' },
] as const;
type JourneyStep = (typeof JOURNEY)[number]['key'];

/**
 * Where an application is on the way from opening to hire, derived only from its real status,
 * stage kind, interviews and offers (no stored or invented state).
 */
export function hiringJourney(
  application: Pick<ApplicationDetail, 'status' | 'stage' | 'interviews' | 'offers'>,
): Step[] {
  const offers = application.offers ?? [];
  const reached: JourneyStep =
    application.status === 'HIRED'
      ? 'HIRE'
      : application.status === 'OFFERED' || offers.length > 0 || application.stage.kind === 'OFFER'
        ? 'OFFER'
        : application.interviews.length > 0 ||
            application.stage.kind === 'INTERVIEW' ||
            application.stage.kind === 'ASSESSMENT' ||
            application.stage.kind === 'REFERENCE_CHECK'
          ? 'INTERVIEWS'
          : 'APPLICATION';
  if (application.status === 'WITHDRAWN' || application.status === 'REJECTED') {
    // Closed: what was reached stays complete, the rest was skipped.
    return lifecycleSteps<string>(JOURNEY, application.status, { reached });
  }
  return lifecycleSteps<JourneyStep>(JOURNEY, reached, { completeAtEnd: true });
}

export function HiringJourney({ application }: { application: ApplicationDetail }) {
  // Same-page workflow links: re-read the URL once the router commits it (owned watcher).
  const notifyLocationChange = useLocationChangeNotifier();
  const full = application.view === 'FULL';
  const links: Array<{ href: string; text: string }> = [
    ...(application.view !== 'INTERVIEWER'
      ? [{ href: '/admin/recruitment#openings', text: `Opening: ${application.opening.title}` }]
      : []),
    ...(application.view !== 'INTERVIEWER'
      ? [{ href: '/admin/recruitment#pipeline', text: 'Pipeline' }]
      : []),
    { href: '#interviews', text: 'Interviews' },
    ...(full ? [{ href: '#offers', text: 'Offers' }] : []),
  ];
  return (
    <section
      aria-label="Hiring journey"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <Stepper label="Hiring progress" steps={hiringJourney(application)} />
      <nav aria-label="Application workflow">
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
