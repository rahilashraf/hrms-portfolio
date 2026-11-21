import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { failure } from './support/performance-fixtures.js';
import {
  candidateDetails,
  FixedRecruitmentClock,
  openingInput,
  openOpening,
  detailOf,
  RECRUITMENT_USERS,
  recruitmentServices,
  type RecruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

describe('Recruitment openings, candidates, pipeline and interviews (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: RecruitmentServices,
      clock: FixedRecruitmentClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, RECRUITMENT_USERS);
          const clock = new FixedRecruitmentClock();
          const svc = recruitmentServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('creates openings scoped by placement, with history and a guarded lifecycle', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      // Recruitment access is never implied by HR, compensation or performance access.
      for (const user of [
        'hr',
        'reader',
        'orgBAdmin',
        'pipelineAdmin',
        'teamRecruiter',
      ]) {
        expect(
          await failure(
            svc.openings.create(openingInput(fx), ctx(fx.users[user]!)),
          ),
        ).toMatchObject({ status: 403 });
      }
      // A team-scoped recruiter creates openings placed on their team (via the position).
      const teamPosition = fx.positionTeamA;
      const teamOpening = await svc.openings.create(
        openingInput(fx, { code: 'req-team', positionId: teamPosition }),
        ctx(fx.users.teamRecruiter!),
      );
      expect(teamOpening).toMatchObject({
        code: 'REQ-TEAM',
        status: 'DRAFT',
        team: { id: fx.teamA },
        department: { id: fx.deptA },
      });
      // Default pipeline stages are created with the organization's first opening.
      expect(
        (await svc.stages.list(fx.users.recruiter!, fx.orgA)).items.map(
          (stage) => stage.code,
        ),
      ).toEqual([
        'APPLIED',
        'SCREENING',
        'PHONE_SCREEN',
        'INTERVIEW',
        'FINAL_INTERVIEW',
        'REFERENCE_CHECK',
        'OFFER',
        'HIRED',
      ]);
      const opening = await svc.openings.create(
        openingInput(fx, {
          compensation: {
            payBasis: 'SALARY',
            min: '55000',
            max: '70000',
            currency: 'cad',
          },
          postedOn: '2026-03-01',
          closesOn: '2026-04-30',
          hiringManagerEmployeeId: fx.employee2,
        }),
        admin,
      );
      expect(opening).toMatchObject({
        compensation: { min: '55000.0000', max: '70000.0000', currency: 'CAD' },
        hiringManager: { id: fx.employee2 },
      });
      expect(
        await failure(svc.openings.create(openingInput(fx), admin)),
      ).toEqual({ status: 409, code: 'RECRUITMENT_OPENING_EXISTS' });
      expect(
        await failure(
          svc.openings.create(
            openingInput(fx, {
              code: 'X2',
              compensation: {
                payBasis: 'HOURLY',
                min: '30',
                max: '20',
                currency: 'CAD',
              },
            }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'RECRUITMENT_COMPENSATION_INVALID' });
      // Cross-organization placement is refused.
      const orgBTitle = await tx.jobTitle.create({
        data: { organizationId: fx.orgB, name: 'B', code: `JB-${fx.suffix}` },
      });
      const orgBPosition = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: orgBTitle.id,
          name: 'B',
          code: `PB-${fx.suffix}`,
        },
      });
      expect(
        await failure(
          svc.openings.create(
            openingInput(fx, { code: 'X3', positionId: orgBPosition.id }),
            admin,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'RECRUITMENT_POSITION_INVALID',
      });
      // Lifecycle.
      expect(
        await failure(svc.openings.transition(opening.id, 'hold', null, admin)),
      ).toMatchObject({ status: 409 });
      await svc.openings.transition(opening.id, 'open', null, admin);
      expect(
        await failure(svc.openings.transition(opening.id, 'hold', null, admin)),
      ).toEqual({ status: 400, code: 'RECRUITMENT_REASON_REQUIRED' });
      await svc.openings.transition(opening.id, 'hold', 'Budget review', admin);
      await svc.openings.transition(opening.id, 'resume', null, admin);
      await svc.openings.update(
        opening.id,
        { title: 'Grade 3 Teacher (French)', openingCount: 2 },
        admin,
      );
      await svc.openings.transition(opening.id, 'close', null, admin);
      expect(
        await failure(
          svc.openings.update(opening.id, { title: 'Again' }, admin),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_OPENING_FROZEN' });
      const detail = await svc.openings.detail(fx.users.reader!, opening.id);
      expect(
        detail.events.map((event) => [event.type, event.toStatus]),
      ).toEqual([
        ['CREATED', 'DRAFT'],
        ['STATUS_CHANGED', 'OPEN'],
        ['STATUS_CHANGED', 'ON_HOLD'],
        ['STATUS_CHANGED', 'OPEN'],
        ['UPDATED', null],
        ['STATUS_CHANGED', 'CLOSED'],
      ]);
      expect(detail.events[4]!.changedFields).toEqual([
        'title',
        'openingCount',
      ]);
      // The database refuses what the service refuses.
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { status: 'OPEN' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.delete({ where: { id: opening.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpeningEvent.deleteMany({ where: { openingId: opening.id } }),
        ),
      ).toBeTruthy();
      // Scoped visibility: dept B readers see no team-A openings; team recruiters see theirs only.
      expect(
        (await svc.openings.list(fx.users.deptBReader!, fx.orgA)).items,
      ).toEqual([]);
      expect(
        (await svc.openings.list(fx.users.teamRecruiter!, fx.orgA)).items.map(
          (row) => row.code,
        ),
      ).toEqual(['REQ-TEAM']);
      expect(
        await failure(svc.openings.detail(fx.users.teamRecruiter!, opening.id)),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(svc.openings.detail(fx.users.orgBAdmin!, opening.id)),
      ).toMatchObject({ status: 404 });
      // The explicit hiring manager (employee 2) reads their opening, without recruitment permissions.
      expect(
        (await svc.openings.detail(fx.selfUser2, opening.id)).actions,
      ).toMatchObject({ isHiringManager: true, canManage: false });
      expect(
        await failure(
          svc.openings.update(opening.id, { title: 'x' }, ctx(fx.selfUser2)),
        ),
      ).toMatchObject({ status: 403 });
    });
  });

  it('configures hiring stages at organization level only and never rewrites history', async () => {
    await scenario(async (_tx, fx, svc) => {
      const pipeline = ctx(fx.users.pipelineAdmin!);
      expect(
        await failure(
          svc.stages.initializeDefaults(fx.orgA, ctx(fx.users.teamPipeline!)),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.stages.initializeDefaults(fx.orgA, ctx(fx.users.recruiter!)),
        ),
      ).toMatchObject({ status: 403 });
      const init = await svc.stages.initializeDefaults(fx.orgA, pipeline);
      expect(init.created).toBe(true);
      expect(
        (await svc.stages.initializeDefaults(fx.orgA, pipeline)).created,
      ).toBe(false);
      const demo = await svc.stages.create(
        {
          organizationId: fx.orgA,
          code: 'demo-lesson',
          name: 'Demo lesson',
          kind: 'ASSESSMENT',
        },
        pipeline,
      );
      expect(
        await failure(
          svc.stages.create(
            {
              organizationId: fx.orgA,
              code: 'HIRED2',
              name: 'Hired again',
              kind: 'HIRED',
            },
            pipeline,
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'RECRUITMENT_STAGE_HIRED_EXISTS',
      });
      const ids = (
        await svc.stages.list(fx.users.pipelineAdmin!, fx.orgA)
      ).items.map((stage) => stage.id);
      const reordered = await svc.stages.reorder(
        fx.orgA,
        [demo.id, ...ids.filter((id) => id !== demo.id)],
        pipeline,
      );
      expect(reordered.items[0]!.code).toBe('DEMO-LESSON');
      expect(
        await failure(svc.stages.reorder(fx.orgA, ids.slice(1), pipeline)),
      ).toEqual({ status: 400, code: 'RECRUITMENT_STAGE_ORDER_INVALID' });
      // A stage with live applications cannot be archived; history keeps the name it had.
      const opening = await openOpening(svc, fx);
      const application = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        ctx(fx.users.recruiter!),
      );
      await svc.applications.moveStage(
        application.id,
        demo.id,
        'Book a lesson',
        ctx(fx.users.recruiter!),
      );
      expect(await failure(svc.stages.archive(demo.id, pipeline))).toEqual({
        status: 409,
        code: 'RECRUITMENT_STAGE_IN_USE',
      });
      await svc.stages.update(
        demo.id,
        { name: 'Demonstration lesson' },
        pipeline,
      );
      const detail = await detailOf(svc, fx.users.recruiter!, application.id);
      expect(detail.transitions!.map((row) => row.toStageName)).toEqual([
        'Applied',
        'Demo lesson',
      ]);
      expect(detail.stage.name).toBe('Demonstration lesson');
    });
  });

  it('deduplicates candidates by email (never by name) and keeps one live application per opening', async () => {
    await scenario(async (tx, fx, svc) => {
      const recruiter = ctx(fx.users.recruiter!);
      const first = await openOpening(svc, fx);
      const second = await openOpening(svc, fx, {
        code: 'REQ-TEACH-2',
        title: 'Grade 4 Teacher',
      });
      const a = await svc.applications.create(
        {
          openingId: first.id,
          candidate: candidateDetails(),
          documents: [
            {
              kind: 'RESUME',
              title: 'CV',
              provider: 'EXTERNAL_URL',
              externalUrl: 'https://drive.example.com/cv.pdf',
            },
          ],
        },
        recruiter,
      );
      // Same email in another case and spacing: the same candidate applies again.
      const b = await svc.applications.create(
        {
          openingId: second.id,
          candidate: candidateDetails({ email: ' ADA.Candidate@Example.com ' }),
        },
        recruiter,
      );
      expect(b.candidateId).toBe(a.candidateId);
      // Same name without email: a different candidate (never merged by name).
      const c = await svc.applications.create(
        { openingId: first.id, candidate: candidateDetails({ email: null }) },
        recruiter,
      );
      expect(c.candidateId).not.toBe(a.candidateId);
      expect(
        await failure(
          svc.applications.create(
            { openingId: first.id, candidateId: a.candidateId },
            recruiter,
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'RECRUITMENT_APPLICATION_EXISTS',
      });
      expect(
        await failure(
          svc.candidates.create(
            { organizationId: fx.orgA, ...candidateDetails() },
            recruiter,
          ),
        ),
      ).toMatchObject({
        status: 409,
        code: 'RECRUITMENT_CANDIDATE_EXISTS',
      });
      // A withdrawn application is kept; the candidate may apply again.
      await svc.applications.withdraw(a.id, 'Accepted another job', recruiter);
      const again = await svc.applications.create(
        { openingId: first.id, candidateId: a.candidateId },
        recruiter,
      );
      expect(
        await tx.recruitmentApplication.count({
          where: { candidateId: a.candidateId, openingId: first.id },
        }),
      ).toBe(2);
      // The database enforces the same uniqueness.
      const stage = await tx.recruitmentStage.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.create({
            data: {
              organizationId: fx.orgA,
              candidateId: a.candidateId,
              openingId: first.id,
              stageId: stage.id,
              appliedAt: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.create({
            data: {
              organizationId: fx.orgA,
              firstName: 'X',
              lastName: 'Y',
              email: 'ada.candidate@example.com',
              normalizedEmail: 'ada.candidate@example.com',
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.create({
            data: {
              organizationId: fx.orgA,
              firstName: 'X',
              lastName: 'Y',
              email: 'Mixed@Example.com',
              normalizedEmail: 'Mixed@Example.com',
            },
          }),
        ),
      ).toBeTruthy();
      // Applications cannot point across organizations.
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.create({
            data: {
              organizationId: fx.orgB,
              candidateId: again.candidateId,
              openingId: second.id,
              stageId: stage.id,
              appliedAt: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
      // The candidate of another organization never matches: org B gets its own candidate.
      const orgBOpening = await svc.openings.create(
        {
          organizationId: fx.orgB,
          code: 'B-1',
          title: 'B teacher',
          employmentType: 'FULL_TIME',
        },
        ctx(fx.users.orgBAdmin!),
      );
      await svc.openings.transition(
        orgBOpening.id,
        'open',
        null,
        ctx(fx.users.orgBAdmin!),
      );
      const orgB = await svc.applications.create(
        { openingId: orgBOpening.id, candidate: candidateDetails() },
        ctx(fx.users.orgBAdmin!),
      );
      expect(orgB.candidateId).not.toBe(a.candidateId);
      expect(
        await failure(
          svc.applications.create(
            { openingId: orgBOpening.id, candidateId: a.candidateId },
            ctx(fx.users.orgBAdmin!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.candidates.detail(fx.users.orgBAdmin!, a.candidateId),
        ),
      ).toMatchObject({ status: 404 });
      // Profile: documents (https only), timeline.
      const profile = await svc.candidates.detail(
        fx.users.reader!,
        a.candidateId,
      );
      expect(profile.applications).toHaveLength(3);
      expect(profile.documents.map((doc) => doc.title)).toEqual(['CV']);
      expect(profile.activity.map((row) => row.type)).toContain(
        'APPLICATION_WITHDRAWN',
      );
      expect(
        await failure(
          svc.candidates.addDocument(
            a.candidateId,
            {
              kind: 'PORTFOLIO',
              title: 'Site',
              provider: 'EXTERNAL_URL',
              externalUrl: 'http://insecure.example.com',
            },
            recruiter,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'RECRUITMENT_URL_INVALID',
      });
      const doc = await svc.candidates.addDocument(
        a.candidateId,
        {
          kind: 'CERTIFICATE',
          title: 'Teaching licence',
          provider: 'GOOGLE_DRIVE',
          externalFileId: '1AbCdEf',
        },
        recruiter,
      );
      expect(
        await failure(svc.candidates.removeDocument(doc.id, '', recruiter)),
      ).toMatchObject({ status: 400 });
      await svc.candidates.removeDocument(
        doc.id,
        'Uploaded to the wrong candidate',
        recruiter,
      );
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidateDocument.update({
            where: { id: doc.id },
            data: { title: 'Rename' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidateDocument.delete({ where: { id: doc.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentActivity.deleteMany({
            where: { candidateId: a.candidateId },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('scopes pipeline access by opening, hiring manager and interviewer, and hides a user’s own candidacy', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const teamOpening = await openOpening(svc, fx, {
        code: 'REQ-TEAM',
        positionId: fx.positionTeamA,
        hiringManagerEmployeeId: fx.employee2,
      });
      const orgOpening = await openOpening(svc, fx, { code: 'REQ-ORG' });
      const teamApp = await svc.applications.create(
        { openingId: teamOpening.id, candidate: candidateDetails() },
        admin,
      );
      const orgApp = await svc.applications.create(
        {
          openingId: orgOpening.id,
          candidate: candidateDetails({
            email: 'grace@example.com',
            firstName: 'Grace',
          }),
        },
        admin,
      );
      // Team recruiter: team pipeline only.
      expect(
        (
          await svc.applications.list(fx.users.teamRecruiter!, fx.orgA)
        ).items.map((row) => row.id),
      ).toEqual([teamApp.id]);
      expect(
        await failure(
          svc.applications.detail(fx.users.teamRecruiter!, orgApp.id),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        (await svc.candidates.list(fx.users.teamRecruiter!, fx.orgA)).items.map(
          (row) => row.id,
        ),
      ).toEqual([teamApp.candidateId]);
      expect(
        await failure(
          svc.candidates.detail(fx.users.teamRecruiter!, orgApp.candidateId),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.applications.moveStage(
            orgApp.id,
            (
              await tx.recruitmentStage.findFirstOrThrow({
                where: { organizationId: fx.orgA, code: 'SCREENING' },
              })
            ).id,
            null,
            ctx(fx.users.teamRecruiter!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      // HR without recruitment permissions sees nothing.
      expect(
        (await svc.applications.list(fx.users.hr!, fx.orgA)).items,
      ).toEqual([]);
      expect(
        await failure(svc.applications.detail(fx.users.hr!, teamApp.id)),
      ).toMatchObject({ status: 404 });
      // The hiring manager (employee 2) reads their opening's applications without offers or screening.
      await svc.applications.recordScreening(
        teamApp.id,
        {
          outcome: 'ADVANCE',
          meetsMinimumQualifications: true,
          notes: 'Strong references',
        },
        admin,
      );
      const managerView = await svc.applications.detail(
        fx.selfUser2,
        teamApp.id,
      );
      expect(managerView.view).toBe('HIRING_MANAGER');
      expect(managerView).not.toHaveProperty('offers');
      expect(managerView).not.toHaveProperty('screening');
      expect(managerView.candidate).not.toHaveProperty('email');
      expect(
        await failure(svc.applications.detail(fx.selfUser2, orgApp.id)),
      ).toMatchObject({ status: 404 });
      // An interviewer (employee 2 on the org opening) sees only their interview and the candidate.
      const interview = await svc.interviews.schedule(
        orgApp.id,
        {
          type: 'VIDEO',
          title: 'Panel interview',
          scheduledStart: '2026-03-16T15:00:00Z',
          durationMinutes: 45,
          meetingUrl: 'https://meet.example.com/abc',
          interviewerUserIds: [fx.selfUser2],
        },
        admin,
      );
      const interviewerView = await svc.applications.detail(
        fx.selfUser2,
        orgApp.id,
      );
      expect(interviewerView.view).toBe('INTERVIEWER');
      expect(interviewerView).not.toHaveProperty('activity');
      expect(interviewerView.interviews.map((row) => row.id)).toEqual([
        interview.id,
      ]);
      // Interviewers are staff of the organization; never the candidate.
      expect(
        await failure(
          svc.interviews.addInterviewer(
            interview.id,
            fx.users.recruiter!,
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'RECRUITMENT_INTERVIEWER_INVALID' });
      // Employee 1 applies internally; with full recruitment rights they still never see it.
      await svc.candidates.setInternalEmployee(
        teamApp.candidateId,
        fx.employee1,
        admin,
      );
      expect(
        await failure(
          svc.interviews.schedule(
            teamApp.id,
            {
              type: 'PHONE',
              title: 'Screen',
              scheduledStart: '2026-03-17T15:00:00Z',
              durationMinutes: 30,
              interviewerUserIds: [fx.selfUser1],
            },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'RECRUITMENT_INTERVIEWER_IS_CANDIDATE' });
      expect(
        (await svc.applications.list(fx.users.self1!, fx.orgA)).items.map(
          (row) => row.id,
        ),
      ).toEqual([orgApp.id]);
      expect(
        await failure(svc.applications.detail(fx.users.self1!, teamApp.id)),
      ).toEqual({ status: 403, code: 'RECRUITMENT_SELF_ACCESS' });
      expect(
        await failure(
          svc.applications.moveStage(
            teamApp.id,
            interview.id,
            null,
            ctx(fx.users.self1!),
          ),
        ),
      ).toEqual({ status: 403, code: 'RECRUITMENT_SELF_ACCESS' });
      expect(
        await failure(
          svc.candidates.detail(fx.users.self1!, teamApp.candidateId),
        ),
      ).toEqual({ status: 403, code: 'RECRUITMENT_SELF_ACCESS' });
      expect(
        (await svc.candidates.list(fx.users.self1!, fx.orgA)).items.map(
          (row) => row.id,
        ),
      ).not.toContain(teamApp.candidateId);
      // The dashboard counts only readable, non-self applications.
      clock.value = new Date('2026-04-10T16:00:00.000Z');
      const dashboard = await svc.dashboard.dashboard(
        fx.users.recruiter!,
        fx.orgA,
      );
      expect(
        dashboard.attention.overdueFeedback.map((row) => row.interviewId),
      ).toEqual([interview.id]);
      expect(
        dashboard.attention.staleApplications
          .map((row) => row.applicationId)
          .sort(),
      ).toEqual([orgApp.id, teamApp.id].sort());
      expect(
        await failure(svc.dashboard.dashboard(fx.users.hr!, fx.orgA)),
      ).toMatchObject({ status: 403 });
    });
  });

  it('moves applications through stages with history, screens them and closes them explicitly', async () => {
    await scenario(async (tx, fx, svc) => {
      const recruiter = ctx(fx.users.recruiter!);
      const opening = await openOpening(svc, fx);
      const app = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        recruiter,
      );
      const stage = (code: string) =>
        tx.recruitmentStage.findFirstOrThrow({
          where: { organizationId: fx.orgA, code },
        });
      await svc.applications.moveStage(
        app.id,
        (await stage('PHONE_SCREEN')).id,
        'Call booked',
        recruiter,
      );
      expect(
        await failure(
          svc.applications.moveStage(
            app.id,
            (await stage('PHONE_SCREEN')).id,
            null,
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_STAGE_UNCHANGED' });
      expect(
        await failure(
          svc.applications.moveStage(
            app.id,
            (await stage('HIRED')).id,
            null,
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_STAGE_HIRED_RESERVED' });
      expect(
        await failure(
          svc.applications.moveStage(
            app.id,
            (await stage('INTERVIEW')).id,
            null,
            ctx(fx.users.reader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      await svc.applications.recordScreening(
        app.id,
        {
          outcome: 'ADVANCE',
          workAuthorizationConfirmed: true,
          availableFrom: '2026-04-01',
        },
        recruiter,
      );
      await svc.applications.recordScreening(
        app.id,
        { outcome: 'HOLD', notes: 'Waiting for licence' },
        recruiter,
      );
      const scheduled = await svc.interviews.schedule(
        app.id,
        {
          type: 'PHONE',
          title: 'Phone screen',
          scheduledStart: '2026-03-20T15:00:00Z',
          durationMinutes: 30,
        },
        recruiter,
      );
      const offer = await svc.offers.create(
        app.id,
        {
          positionId: fx.positionOrg,
          employmentType: 'FULL_TIME',
          startDate: '2026-04-01',
          payBasis: 'HOURLY',
          rateAmount: '32.50',
          currency: 'CAD',
        },
        ctx(fx.users.hiringAdmin!),
      );
      await svc.applications.reject(
        app.id,
        'Position requires a licence',
        recruiter,
      );
      expect(
        await tx.recruitmentInterview.findUniqueOrThrow({
          where: { id: scheduled.id },
        }),
      ).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'Application closed',
      });
      expect(
        await tx.recruitmentOffer.findUniqueOrThrow({
          where: { id: offer.id },
        }),
      ).toMatchObject({ status: 'WITHDRAWN' });
      expect(
        await failure(
          svc.applications.moveStage(
            app.id,
            (await stage('INTERVIEW')).id,
            null,
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_APPLICATION_CLOSED' });
      expect(
        await failure(
          svc.applications.recordScreening(
            app.id,
            { outcome: 'ADVANCE' },
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_APPLICATION_CLOSED' });
      const detail = await detailOf(svc, fx.users.reader!, app.id);
      expect(detail).toMatchObject({
        status: 'REJECTED',
        dispositionReason: 'Position requires a licence',
        screening: { outcome: 'HOLD' },
      });
      expect(detail.activity!.map((row) => row.type).reverse()).toEqual([
        'APPLICATION_RECEIVED',
        'STAGE_CHANGED',
        'SCREENING_RECORDED',
        'SCREENING_RECORDED',
        'INTERVIEW_SCHEDULED',
        'OFFER_CREATED',
        'OFFER_WITHDRAWN',
        'APPLICATION_REJECTED',
      ]);
      // Closed applications are frozen in the database too.
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.update({
            where: { id: app.id },
            data: { status: 'ACTIVE' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.update({
            where: { id: app.id },
            data: { stageId: scheduled.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.delete({ where: { id: app.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentStageTransition.deleteMany({
            where: { applicationId: app.id },
          }),
        ),
      ).toBeTruthy();
      // The application audit carries identifiers only (no candidate details or notes). "Ada"
      // is matched as a word: the identifiers are random UUIDs whose hex digits can contain
      // "ada" (about 2% of runs failed on that before).
      const audits = await tx.auditLog.findMany({
        where: { entityId: app.id },
      });
      expect(JSON.stringify(audits.map((row) => row.metadata))).not.toMatch(
        /\bAda\b|Lovelace|licence|ada\.candidate/i,
      );
    });
  });

  it('locks submitted interview feedback and reopens it only as a new revision', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const opening = await openOpening(svc, fx);
      const app = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        admin,
      );
      const interview = await svc.interviews.schedule(
        app.id,
        {
          type: 'IN_PERSON',
          title: 'Classroom visit',
          scheduledStart: '2026-03-16T15:00:00Z',
          durationMinutes: 60,
          location: 'Room 12',
          interviewerUserIds: [fx.selfUser2],
        },
        admin,
      );
      expect(
        await failure(
          svc.interviews.schedule(
            app.id,
            {
              type: 'VIDEO',
              title: 'x',
              scheduledStart: '2026-03-16T15:00:00Z',
              durationMinutes: 30,
              meetingUrl: 'http://zoom.example.com',
            },
            admin,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'RECRUITMENT_URL_INVALID',
      });
      // Only the interviewer writes their feedback.
      expect(
        await failure(
          svc.interviews.saveFeedback(interview.id, { rating: 4 }, admin),
        ),
      ).toEqual({ status: 403, code: 'RECRUITMENT_NOT_INTERVIEWER' });
      const interviewer = ctx(fx.selfUser2);
      await svc.interviews.saveFeedback(
        interview.id,
        { rating: 4, strengths: 'Warm with students' },
        interviewer,
      );
      expect(
        await failure(
          svc.interviews.submitFeedback(interview.id, {}, interviewer),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_INTERVIEW_NOT_STARTED' });
      clock.value = new Date('2026-03-16T17:00:00.000Z');
      expect(
        await failure(
          svc.interviews.submitFeedback(interview.id, {}, interviewer),
        ),
      ).toEqual({
        status: 400,
        code: 'RECRUITMENT_FEEDBACK_RECOMMENDATION_REQUIRED',
      });
      const submitted = await svc.interviews.submitFeedback(
        interview.id,
        { recommendation: 'YES', concerns: 'Limited French' },
        interviewer,
      );
      expect(submitted).toMatchObject({
        status: 'SUBMITTED',
        rating: 4,
        strengths: 'Warm with students',
        concerns: 'Limited French',
        revision: 1,
      });
      expect(
        await failure(
          svc.interviews.saveFeedback(interview.id, { rating: 5 }, interviewer),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_FEEDBACK_SUBMITTED' });
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewFeedback.update({
            where: { id: submitted.id },
            data: { rating: 5 },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewFeedback.delete({
            where: { id: submitted.id },
          }),
        ),
      ).toBeTruthy();
      // Readers see submitted feedback; reopening needs recruitment.manage and keeps the original.
      expect(
        (await detailOf(svc, fx.users.reader!, app.id)).interviews[0]!.feedback,
      ).toHaveLength(1);
      expect(
        await failure(
          svc.interviews.reopenFeedback(
            submitted.id,
            'Typo',
            ctx(fx.users.reader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const reopened = await svc.interviews.reopenFeedback(
        submitted.id,
        'Concern belongs to another candidate',
        admin,
      );
      expect(reopened).toMatchObject({
        status: 'DRAFT',
        revision: 2,
        concerns: 'Limited French',
      });
      await svc.interviews.submitFeedback(
        interview.id,
        { recommendation: 'STRONG_YES', concerns: null },
        interviewer,
      );
      const history = await svc.interviews.feedbackHistory(
        fx.users.reader!,
        interview.id,
      );
      expect(
        history.items.map((row) => [
          row.revision,
          row.recommendation,
          row.supersededAt !== null,
        ]),
      ).toEqual([
        [1, 'YES', true],
        [2, 'STRONG_YES', false],
      ]);
      // The interviewer's own list and the completed interview.
      const mine = await svc.interviews.mine(fx.selfUser2);
      expect(mine.items[0]).toMatchObject({
        id: interview.id,
        myFeedback: { revision: 2, status: 'SUBMITTED' },
      });
      await svc.interviews.conclude(interview.id, 'COMPLETED', null, admin);
      expect(
        await failure(
          svc.interviews.reschedule(
            interview.id,
            { durationMinutes: 30 },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_INTERVIEW_NOT_SCHEDULED' });
      expect(
        await violation(tx, () =>
          tx.recruitmentInterview.update({
            where: { id: interview.id },
            data: { title: 'Changed' },
          }),
        ),
      ).toBeTruthy();
      const activity = (
        await detailOf(svc, fx.users.reader!, app.id)
      ).activity!.map((row) => row.type);
      expect(activity).toEqual(
        expect.arrayContaining([
          'INTERVIEW_SCHEDULED',
          'FEEDBACK_SUBMITTED',
          'FEEDBACK_REOPENED',
          'INTERVIEW_COMPLETED',
        ]),
      );
      // Feedback content never enters the timeline or the audit log.
      const audits = await tx.auditLog.findMany({
        where: { action: { startsWith: 'RECRUITMENT_FEEDBACK' } },
      });
      expect(JSON.stringify(audits.map((row) => row.metadata))).not.toMatch(
        /French|Warm/,
      );
    });
  });

  it('merges duplicate candidates explicitly and permanently', async () => {
    await scenario(async (tx, fx, svc) => {
      const recruiter = ctx(fx.users.recruiter!);
      const first = await openOpening(svc, fx);
      const second = await openOpening(svc, fx, { code: 'REQ-TEACH-2' });
      const withEmail = await svc.applications.create(
        { openingId: first.id, candidate: candidateDetails() },
        recruiter,
      );
      const noEmail = await svc.applications.create(
        {
          openingId: second.id,
          candidate: candidateDetails({
            email: null,
            phone: null,
            location: 'Ottawa',
          }),
        },
        recruiter,
      );
      const clash = await svc.applications.create(
        { openingId: first.id, candidate: candidateDetails({ email: null }) },
        recruiter,
      );
      expect(
        await failure(
          svc.candidates.merge(
            noEmail.candidateId,
            withEmail.candidateId,
            ctx(fx.users.teamRecruiter!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      // A live application to the same opening blocks the merge.
      expect(
        await failure(
          svc.candidates.merge(
            clash.candidateId,
            withEmail.candidateId,
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_MERGE_CONFLICT' });
      const merged = await svc.candidates.merge(
        noEmail.candidateId,
        withEmail.candidateId,
        recruiter,
      );
      expect(merged).toMatchObject({
        id: withEmail.candidateId,
        location: 'Ottawa',
        email: 'ada.candidate@example.com',
      });
      expect(
        await tx.recruitmentApplication.findUniqueOrThrow({
          where: { id: noEmail.id },
        }),
      ).toMatchObject({ candidateId: withEmail.candidateId });
      expect(
        await tx.recruitmentCandidate.findUniqueOrThrow({
          where: { id: noEmail.candidateId },
        }),
      ).toMatchObject({
        status: 'MERGED',
        mergedIntoCandidateId: withEmail.candidateId,
      });
      expect(
        await failure(
          svc.candidates.merge(
            noEmail.candidateId,
            clash.candidateId,
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_MERGE_INVALID' });
      expect(
        await failure(
          svc.candidates.update(
            noEmail.candidateId,
            { firstName: 'X' },
            recruiter,
          ),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_CANDIDATE_MERGED' });
      // Only along a recorded merge can an application change candidate; a merge never undoes.
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.update({
            where: { id: clash.id },
            data: { candidateId: withEmail.candidateId },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.update({
            where: { id: noEmail.candidateId },
            data: {
              status: 'ACTIVE',
              mergedIntoCandidateId: null,
              mergedAt: null,
            },
          }),
        ),
      ).toBeTruthy();
      const profile = await svc.candidates.detail(
        fx.users.recruiter!,
        withEmail.candidateId,
      );
      expect(profile.applications.map((row) => row.id).sort()).toEqual(
        [withEmail.id, noEmail.id].sort(),
      );
      expect(
        profile.activity.filter((row) => row.type === 'CANDIDATE_MERGED'),
      ).toHaveLength(2);
    });
  });
});
