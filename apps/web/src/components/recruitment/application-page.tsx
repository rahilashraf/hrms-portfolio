'use client';

import { PageHeader } from '../ui/page-header';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageContainer } from '../ui/page-container';
import { LoadingState } from '../ui/states';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { hasPermission } from '../../lib/authorization/can';
import { recruitmentApi } from '../../lib/recruitment/api';
import { isRecruitmentForbidden, recruitmentErrorMessage } from '../../lib/recruitment/errors';
import type { ApplicationDetail, HireResult } from '../../lib/recruitment/types';
import {
  ActivityTimeline,
  ApplicationStatusBadge,
  dateTimeText,
  DocumentsSection,
  label,
  Section,
} from './recruitment-shared';
import { useAuth } from '../../providers/auth-provider';
import type { Run } from './application/application-shared';
import { Disposition } from './application/disposition';
import { HirePanel } from './application/hire-panel';
import { HiringJourney } from './application/hiring-journey';
import { InterviewsSection } from './application/interviews-section';
import { OffersSection } from './application/offers-section';
import { ScreeningSection } from './application/screening-section';
import { StageMove } from './application/stage-move';
export { hiringJourney } from './application/hiring-journey';

const VIEW_LABELS: Record<ApplicationDetail['view'], string> = {
  FULL: 'Recruiter view',
  HIRING_MANAGER: 'Hiring manager view',
  INTERVIEWER: 'Interviewer view',
};

/**
 * One application, as the viewer may see and act on it (decided by the API): recruiters see
 * everything (screening, offers, hire conversion); hiring managers see the pipeline, interviews
 * and feedback but not screening or offers; interviewers see the candidate's name, the opening,
 * the stage, documents and their own interviews only.
 */
export function ApplicationPage({ applicationId }: { applicationId: string }) {
  const { authorization } = useAuth();
  const canStartOnboarding = hasPermission(authorization, 'onboarding.manage');
  const canMoveDocuments = hasPermission(authorization, 'document.manage');
  const [application, setApplication] = useState<ApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hired, setHired] = useState<HireResult | null>(null);

  const load = useCallback(async () => {
    try {
      setApplication(await recruitmentApi.application(applicationId));
      setError(null);
    } catch (cause) {
      setForbidden(isRecruitmentForbidden(cause));
      setError(recruitmentErrorMessage(cause, 'Unable to load the application.'));
    } finally {
      setLoading(false);
    }
  }, [applicationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run: Run = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(recruitmentErrorMessage(cause, 'Unable to save the change.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <LoadingState label="Loading application…" />
      </PageContainer>
    );
  }
  if (forbidden) {
    return (
      <PageContainer padded={false}>
        <Forbidden message="You do not have access to this application." />
      </PageContainer>
    );
  }
  if (!application) {
    return (
      <PageContainer>
        <ErrorBanner>{error ?? 'Unable to load the application.'}</ErrorBanner>
      </PageContainer>
    );
  }

  const { view, actions, candidate } = application;
  const full = view === 'FULL';

  return (
    <PageContainer className="space-y-6">
      <div>
        <Link
          href={view === 'INTERVIEWER' ? '/interviews' : '/admin/recruitment'}
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          ← {view === 'INTERVIEWER' ? 'My interviews' : 'Recruitment'}
        </Link>
        <div className="mt-2">
          <PageHeader
            title={
              <>
                {candidate.displayName}
                {candidate.internal && (
                  <span className="ml-2 align-middle text-sm font-medium text-indigo-700">
                    Internal candidate
                  </span>
                )}
              </>
            }
            description={
              <>
                {application.opening.title} ({application.opening.code}) ·{' '}
                {application.organization.name}
              </>
            }
          />
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="inline text-slate-500">Stage: </dt>
            <dd className="inline">{application.stage.name}</dd>
          </div>
          {view !== 'INTERVIEWER' && (
            <div>
              <dt className="inline text-slate-500">Status </dt>
              <dd className="inline">
                <ApplicationStatusBadge status={application.status} />
              </dd>
            </div>
          )}
          <div>
            <dt className="inline text-slate-500">View: </dt>
            <dd className="inline">{VIEW_LABELS[view]}</dd>
          </div>
          {full && (
            <>
              <div>
                <dt className="inline text-slate-500">Email: </dt>
                <dd className="inline">{candidate.email ?? '—'}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">Phone: </dt>
                <dd className="inline">{candidate.phone ?? '—'}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">Source: </dt>
                <dd className="inline">{label(application.source)}</dd>
              </div>
            </>
          )}
        </dl>
        {full && (
          <Link
            href={`/recruitment/candidates/${candidate.id}`}
            className="mt-2 inline-block text-sm text-indigo-700 underline"
          >
            Candidate profile
          </Link>
        )}
        {application.dispositionReason && (
          <p className="mt-2 text-sm text-slate-700">
            {label(application.status)}: {application.dispositionReason}
          </p>
        )}
      </div>
      <HiringJourney application={application} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}

      {actions.canMoveStage && (
        <StageMove application={application} busy={busy} run={run} onError={setError} />
      )}
      {full && <ScreeningSection application={application} busy={busy} run={run} />}
      <InterviewsSection application={application} busy={busy} run={run} />
      {full && <OffersSection application={application} busy={busy} run={run} />}
      {full && (application.hire || actions.canHire || hired) && (
        <HirePanel
          application={application}
          hired={hired}
          canStartOnboarding={canStartOnboarding}
          canMoveDocuments={canMoveDocuments}
          onHired={async (result) => {
            setHired(result);
            await load();
            setSuccess(`Converted to employee ${result.employeeNumber}.`);
          }}
        />
      )}
      <DocumentsSection
        documents={application.documents}
        canManage={full && actions.canManage}
        busy={busy}
        run={run}
        onAdd={(input) =>
          recruitmentApi.addDocument(candidate.id, { ...input, applicationId: application.id })
        }
        onRemove={(documentId, reason) => recruitmentApi.removeDocument(documentId, reason)}
      />
      {application.transitions && application.transitions.length > 0 && (
        <Section title="Stage history">
          <ol className="space-y-1 text-sm text-slate-800">
            {application.transitions.map((transition) => (
              <li key={transition.id}>
                <span className="text-slate-500">{dateTimeText(transition.createdAt)}</span>{' '}
                {transition.fromStageName ? `${transition.fromStageName} → ` : ''}
                {transition.toStageName}
                {transition.note ? ` — ${transition.note}` : ''}
              </li>
            ))}
          </ol>
        </Section>
      )}
      {application.activity && <ActivityTimeline activity={application.activity} />}
      {(actions.canWithdraw || actions.canReject) && (
        <Disposition application={application} busy={busy} run={run} />
      )}
    </PageContainer>
  );
}
