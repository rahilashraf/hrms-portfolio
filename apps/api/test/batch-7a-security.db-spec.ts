import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  activeTemplate,
  FixedOnboardingClock,
  ONBOARDING_USERS,
  onboardingServices,
  type OnboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  candidateDetails,
  FixedRecruitmentClock,
  openingInput,
  openOpening,
  RECRUITMENT_USERS,
  recruitmentServices,
  type RecruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Batch 7A — regression tests for the five security findings of the Batch 7 audit (S1–S5). Each
 * failed on the code before its fix.
 */
describe('Batch 7A security findings (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function recruitment(
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

  async function onboarding(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: OnboardingServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, ONBOARDING_USERS);
          const svc = onboardingServices(
            rollbackClient(tx),
            new FixedOnboardingClock(),
          );
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const interviewInput = (interviewerUserIds: string[]) => ({
    type: 'IN_PERSON' as const,
    title: 'Classroom visit',
    scheduledStart: '2026-03-16T15:00:00Z',
    durationMinutes: 60,
    location: 'Room 12',
    interviewerUserIds,
  });

  it("S1: feedback history never shows another interviewer's unsubmitted draft", async () => {
    await recruitment(async (_tx, fx, svc, clock) => {
      const admin = ctx(fx.users.hiringAdmin!);
      // Employee 2 is both the opening's hiring manager and an interviewer.
      const opening = await openOpening(svc, fx, {
        positionId: fx.positionTeamA,
        hiringManagerEmployeeId: fx.employee2,
      });
      const app = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        admin,
      );
      const interview = await svc.interviews.schedule(
        app.id,
        interviewInput([fx.selfUser1, fx.selfUser2]),
        admin,
      );
      // Interviewer 1 keeps a private draft; interviewer 2 submits theirs.
      await svc.interviews.saveFeedback(
        interview.id,
        { rating: 2, concerns: 'Private draft: unsure about references' },
        ctx(fx.selfUser1),
      );
      clock.value = new Date('2026-03-16T17:00:00.000Z');
      await svc.interviews.saveFeedback(
        interview.id,
        { rating: 4, strengths: 'Clear lesson plan' },
        ctx(fx.selfUser2),
      );
      await svc.interviews.submitFeedback(
        interview.id,
        { recommendation: 'YES' },
        ctx(fx.selfUser2),
      );

      const authorsAndStatus = async (userId: string) =>
        (await svc.interviews.feedbackHistory(userId, interview.id)).items.map(
          (row) => [row.interviewerUserId, row.status],
        );
      // A full reader (recruitment.read, organization-wide) sees submitted feedback only.
      const full = await authorsAndStatus(fx.users.reader!);
      expect(full).toEqual([[fx.selfUser2, 'SUBMITTED']]);
      expect(
        JSON.stringify(
          await svc.interviews.feedbackHistory(fx.users.reader!, interview.id),
        ),
      ).not.toContain('Private draft');
      // The hiring manager (who also interviews) sees submitted feedback and their own rows.
      expect(await authorsAndStatus(fx.selfUser2)).toEqual([
        [fx.selfUser2, 'SUBMITTED'],
      ]);
      // A full reader who also interviews sees submitted feedback and their own draft.
      expect(
        (await authorsAndStatus(fx.selfUser1)).sort((a, b) =>
          String(a[1]).localeCompare(String(b[1])),
        ),
      ).toEqual([
        [fx.selfUser1, 'DRAFT'],
        [fx.selfUser2, 'SUBMITTED'],
      ]);
      // The reopened draft of a submitted revision is private to its author too.
      const submitted = (
        await svc.interviews.feedbackHistory(fx.users.reader!, interview.id)
      ).items[0]!;
      await svc.interviews.reopenFeedback(submitted.id, 'Correction', admin);
      expect(await authorsAndStatus(fx.users.reader!)).toEqual([
        [fx.selfUser2, 'SUBMITTED'],
      ]);
      expect(await authorsAndStatus(fx.selfUser2)).toEqual([
        [fx.selfUser2, 'SUBMITTED'],
        [fx.selfUser2, 'DRAFT'],
      ]);
      // Another organization's administrator does not reach it.
      expect(
        await failure(
          svc.interviews.feedbackHistory(fx.users.orgBAdmin!, interview.id),
        ),
      ).toMatchObject({ status: 404 });
    });
  });

  it("S3: a new candidate's email never attaches the application to a candidate the recruiter cannot read", async () => {
    await recruitment(async (tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const teamOpening = await openOpening(svc, fx, {
        code: 'REQ-TEAM',
        positionId: fx.positionTeamA,
      });
      const orgOpening = await openOpening(svc, fx, { code: 'REQ-ORG' });
      // Jane applies to the organization-level opening (out of the team recruiter's reach).
      const jane = await svc.applications.create(
        {
          openingId: orgOpening.id,
          candidate: candidateDetails({
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jane@example.com',
            phone: '+1 555 0199',
          }),
        },
        admin,
      );
      const teamRecruiter = ctx(fx.users.teamRecruiter!);
      const attempt = await failure(
        svc.applications.create(
          {
            openingId: teamOpening.id,
            candidate: candidateDetails({
              firstName: 'John',
              lastName: 'Smith',
              email: 'JANE@example.com',
            }),
          },
          teamRecruiter,
        ),
      );
      expect(attempt).toEqual({
        status: 409,
        code: 'RECRUITMENT_CANDIDATE_EMAIL_UNAVAILABLE',
      });
      // Nothing was attached or created, and Jane's record is untouched.
      expect(
        await tx.recruitmentApplication.count({
          where: { openingId: teamOpening.id },
        }),
      ).toBe(0);
      expect(
        await tx.recruitmentCandidate.findUniqueOrThrow({
          where: { id: jane.candidateId },
        }),
      ).toMatchObject({ firstName: 'Jane', lastName: 'Doe' });
      // The candidate stays unreadable to the team recruiter.
      expect(
        await failure(
          svc.candidates.detail(fx.users.teamRecruiter!, jane.candidateId),
        ),
      ).toMatchObject({ status: 404 });
      // An archived match answers the same neutral refusal (it reveals nothing more).
      await tx.recruitmentCandidate.update({
        where: { id: jane.candidateId },
        data: { status: 'ARCHIVED' },
      });
      expect(
        await failure(
          svc.applications.create(
            {
              openingId: teamOpening.id,
              candidate: candidateDetails({ email: 'jane@example.com' }),
            },
            teamRecruiter,
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'RECRUITMENT_CANDIDATE_EMAIL_UNAVAILABLE',
      });
      await tx.recruitmentCandidate.update({
        where: { id: jane.candidateId },
        data: { status: 'ACTIVE' },
      });
      // A recruiter who can read the candidate reuses it, as before.
      const reused = await svc.applications.create(
        {
          openingId: teamOpening.id,
          candidate: candidateDetails({ email: 'jane@example.com' }),
        },
        admin,
      );
      expect(reused.candidateId).toBe(jane.candidateId);
      // A team recruiter whose own pipeline already holds the candidate reuses it too.
      const second = await openOpening(svc, fx, {
        code: 'REQ-TEAM-2',
        positionId: fx.positionTeamA,
      });
      const viaTeam = await svc.applications.create(
        {
          openingId: second.id,
          candidate: candidateDetails({ email: 'jane@example.com' }),
        },
        teamRecruiter,
      );
      expect(viaTeam.candidateId).toBe(jane.candidateId);
      // A brand-new email still creates a new candidate.
      const fresh = await svc.applications.create(
        {
          openingId: teamOpening.id,
          candidate: candidateDetails({
            firstName: 'Sam',
            email: 'sam.new@example.com',
          }),
        },
        teamRecruiter,
      );
      expect(fresh.candidateId).not.toBe(jane.candidateId);
    });
  });

  it('S4: the hiring manager view of an application omits screening and offer activity', async () => {
    await recruitment(async (_tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const opening = await openOpening(svc, fx, {
        positionId: fx.positionTeamA,
        hiringManagerEmployeeId: fx.employee2,
      });
      const app = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        admin,
      );
      await svc.applications.recordScreening(
        app.id,
        { outcome: 'ADVANCE', meetsMinimumQualifications: true },
        admin,
      );
      const offer = await svc.offers.create(
        app.id,
        {
          positionId: fx.positionTeamA,
          employmentType: 'FULL_TIME',
          startDate: '2026-04-01',
          payBasis: 'SALARY',
          rateAmount: '62000.00',
          currency: 'CAD',
          expiresOn: '2026-03-25',
        },
        admin,
      );
      await svc.offers.act(offer.id, 'approve', null, admin);
      const types = (detail: unknown) =>
        ((detail as { activity?: Array<{ type: string }> }).activity ?? []).map(
          (row) => row.type,
        );
      const full = await svc.applications.detail(fx.users.reader!, app.id);
      expect(types(full)).toEqual(
        expect.arrayContaining([
          'SCREENING_RECORDED',
          'OFFER_CREATED',
          'OFFER_APPROVED',
        ]),
      );
      const manager = await svc.applications.detail(fx.selfUser2, app.id);
      expect(manager.view).toBe('HIRING_MANAGER');
      expect(types(manager)).toContain('APPLICATION_RECEIVED');
      expect(
        types(manager).filter(
          (type) => type === 'SCREENING_RECORDED' || type.startsWith('OFFER_'),
        ),
      ).toEqual([]);
      expect(JSON.stringify(manager)).not.toMatch(/Screening recorded|Offer /);
    });
  });

  it('S2: importing form responses completes only workflow kinds the importer manages', async () => {
    await onboarding(async (tx, fx, svc) => {
      await activeTemplate(svc, fx, {
        kind: 'OFFBOARDING',
        code: 'EXIT',
        tasks: [
          {
            title: 'Complete the exit survey',
            category: 'TRAINING' as const,
            ownerType: 'EMPLOYEE' as const,
            dueOffsetDays: 0,
            referenceType: 'GOOGLE_FORM' as const,
            referenceExternalId: 'exit-survey',
            referenceUrl: 'https://docs.google.com/forms/d/exit-survey',
          },
        ] as never,
      });
      const workflow = await svc.workflows.start(
        'OFFBOARDING',
        {
          employmentAssignmentId: fx.assignmentTeamA,
          plannedEndDate: '2026-04-30',
        },
        ctx(fx.users.offboardingHr!),
      );
      const email = (
        await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } })
      ).email;
      const submission = {
        externalResourceId: 'exit-survey',
        externalResponseId: 'resp-exit-1',
        respondentEmail: email,
        submittedAt: '2026-03-16T10:00:00Z',
      };
      // Onboarding access never reaches an offboarding task.
      const onboardingImport = await svc.tasks.completeFromSubmissions(
        fx.orgA,
        'GOOGLE_FORM',
        [submission],
        fx.users.onboardingHr!,
      );
      expect(onboardingImport.outcomes[0]).toMatchObject({
        outcome: 'NO_OPEN_TASK',
      });
      expect(onboardingImport.outcomes[0]!.taskId ?? null).toBeNull();
      const task = await tx.employeeWorkflowTask.findFirstOrThrow({
        where: { workflowId: workflow.id },
      });
      expect(task.status).not.toBe('COMPLETED');
      // Completing it directly is refused as well.
      expect(
        (
          await failure(
            svc.tasks.complete(task.id, {}, ctx(fx.users.onboardingHr!)),
          )
        ).status,
      ).toBeGreaterThanOrEqual(403);
      // Offboarding access completes it.
      const offboardingImport = await svc.tasks.completeFromSubmissions(
        fx.orgA,
        'GOOGLE_FORM',
        [submission],
        fx.users.offboardingHr!,
      );
      expect(offboardingImport.outcomes[0]).toMatchObject({
        outcome: 'COMPLETED',
        taskId: task.id,
      });
    });
  });

  it('S5: a template task owned by the employee themself starts in the HR pool, never with them', async () => {
    await onboarding(async (tx, fx, svc) => {
      await activeTemplate(svc, fx, {
        kind: 'OFFBOARDING',
        code: 'EXIT-IT',
        tasks: [
          {
            title: 'Disable HRMS and Google accounts',
            category: 'ACCOUNT_ACCESS' as const,
            ownerType: 'SPECIFIC_USER' as const,
            // Employee 1's own account (an IT administrator, say).
            ownerUserId: fx.selfUser1,
            dueOffsetDays: 1,
          },
          {
            title: 'Collect equipment',
            category: 'PAPERWORK' as const,
            ownerType: 'SPECIFIC_USER' as const,
            ownerUserId: fx.users.itDesk!,
            dueOffsetDays: 0,
          },
        ] as never,
      });
      const workflow = await svc.workflows.start(
        'OFFBOARDING',
        {
          employmentAssignmentId: fx.assignmentTeamA,
          plannedEndDate: '2026-04-30',
        },
        ctx(fx.users.offboardingHr!),
      );
      const tasks = await tx.employeeWorkflowTask.findMany({
        where: { workflowId: workflow.id },
        orderBy: { sortOrder: 'asc' },
      });
      expect(
        tasks.map((task) => [task.title, task.ownerType, task.ownerUserId]),
      ).toEqual([
        ['Disable HRMS and Google accounts', 'HR', null],
        ['Collect equipment', 'SPECIFIC_USER', fx.users.itDesk],
      ]);
      // The employee is not given their own offboarding task to work.
      const mine = await svc.workflows.myTasks(fx.selfUser1, true);
      expect(
        mine.items.map((item: { title: string }) => item.title),
      ).not.toContain('Disable HRMS and Google accounts');
    });
  });

  it('Q4: recruitment records looked up by id answer 404 to another organization, 403 within it', async () => {
    await recruitment(async (tx, fx, svc) => {
      const pipeline = ctx(fx.users.pipelineAdmin!);
      const intake = ctx(fx.users.intakeAdmin!);
      const outsider = ctx(fx.users.orgBAdmin!);
      const insider = ctx(fx.users.reader!);
      const stage = await svc.stages.create(
        {
          organizationId: fx.orgA,
          code: 'PHONE',
          name: 'Phone screen',
          kind: 'SCREENING' as never,
        },
        pipeline,
      );
      const source = await svc.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'FORM',
          name: 'Careers form',
          provider: 'MANUAL_IMPORT',
        },
        intake,
      );
      const submission = await tx.recruitmentIntakeSubmission.create({
        data: {
          organizationId: fx.orgA,
          sourceId: source.id,
          externalResponseId: 'resp-q4',
          status: 'PENDING_OPENING',
          submission: {},
          contentHash: 'q4',
          submittedAt: new Date('2026-03-14T12:00:00Z'),
        },
      });
      const cases: [string, (c: ReturnType<typeof ctx>) => Promise<unknown>][] =
        [
          [
            'stage update',
            (c) => svc.stages.update(stage.id, { name: 'X' }, c),
          ],
          ['stage archive', (c) => svc.stages.archive(stage.id, c)],
          [
            'source update',
            (c) => svc.intake.updateSource(source.id, { name: 'X' }, c),
          ],
          ['source archive', (c) => svc.intake.archiveSource(source.id, c)],
          // Review finding: importing into a source looked up by id.
          [
            'source import',
            (c) =>
              svc.intake.ingest(source.id, [], 'IMPORT', c.actorUserId ?? null),
          ],
          [
            'submission reject',
            (c) => svc.intake.rejectSubmission(submission.id, 'Spam', c),
          ],
          [
            'submission assign',
            (c) => svc.intake.assignOpening(submission.id, fx.orgA, c),
          ],
        ];
      // A caller of the organization with no recruitment grant (Core HR only) keeps the 403.
      const coreHr = ctx(fx.users.hr!);
      for (const [name, call] of cases) {
        expect([name, (await failure(call(outsider))).status]).toEqual([
          name,
          404,
        ]);
        expect([name, (await failure(call(insider))).status]).toEqual([
          name,
          403,
        ]);
        expect([name, (await failure(call(coreHr))).status]).toEqual([
          name,
          403,
        ]);
      }
      // D4: opening creation is authorized before its ids are validated — an unknown and a
      // real hiring manager give the same refusal.
      for (const hiringManagerEmployeeId of [
        fx.employee2,
        '00000000-0000-4000-8000-000000000000',
      ]) {
        expect(
          await failure(
            svc.openings.create(
              openingInput(fx, { code: 'REQ-Q4', hiringManagerEmployeeId }),
              outsider,
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
    });
  });

  it('Q4: onboarding start and template changes answer 404 to another organization, 403 within it', async () => {
    await onboarding(async (_tx, fx, svc) => {
      const template = await activeTemplate(svc, fx, { code: 'Q4' });
      const outsider = ctx(fx.users.orgBAdmin!);
      const reader = ctx(fx.users.onboardingReader!);
      const start = (c: ReturnType<typeof ctx>) =>
        svc.workflows.start(
          'ONBOARDING',
          { employmentAssignmentId: fx.assignmentTeamA },
          c,
        );
      expect(await failure(start(outsider))).toMatchObject({ status: 404 });
      expect(await failure(start(reader))).toMatchObject({ status: 403 });
      // Onboarding HR works in the organization: offboarding stays a 403.
      expect(
        await failure(
          svc.workflows.start(
            'OFFBOARDING',
            {
              employmentAssignmentId: fx.assignmentTeamA,
              plannedEndDate: '2026-04-30',
            },
            ctx(fx.users.onboardingHr!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const changes: [
        string,
        (c: ReturnType<typeof ctx>) => Promise<unknown>,
      ][] = [
        [
          'update',
          (c) =>
            svc.templates.update(
              template.id,
              {
                tasks: [
                  {
                    title: 'Probe',
                    category: 'PAPERWORK',
                    ownerType: 'SPECIFIC_USER',
                    ownerUserId: '00000000-0000-4000-8000-000000000000',
                    dueOffsetDays: 0,
                  },
                ],
              } as never,
              c,
            ),
        ],
        ['archive', (c) => svc.templates.archive(template.id, c)],
        ['default', (c) => svc.templates.setDefault(template.id, c)],
      ];
      for (const [name, call] of changes) {
        expect([name, (await failure(call(outsider))).status]).toEqual([
          name,
          404,
        ]);
        expect([name, (await failure(call(reader))).status]).toEqual([
          name,
          403,
        ]);
      }
    });
  });
});
