import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { RECRUITMENT_USERS } from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** Raw rows: the database enforces Recruitment's invariants without the services. */
describe('Recruitment database integrity', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, RECRUITMENT_USERS);
          await run(tx, fx);
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function world(tx: Tx, fx: SchedulingFixtures) {
    const stage = await tx.recruitmentStage.create({
      data: {
        organizationId: fx.orgA,
        code: 'APPLIED',
        name: 'Applied',
        kind: 'APPLIED',
        sortOrder: 10,
      },
    });
    const opening = await tx.jobOpening.create({
      data: {
        organizationId: fx.orgA,
        code: 'REQ-1',
        title: 'Teacher',
        employmentType: 'FULL_TIME',
      },
    });
    const candidate = await tx.recruitmentCandidate.create({
      data: {
        organizationId: fx.orgA,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        normalizedEmail: 'ada@example.com',
      },
    });
    return { stage, opening, candidate };
  }

  it('keeps openings inside their organization and guards their lifecycle', async () => {
    await scenario(async (tx, fx) => {
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
      const base = {
        organizationId: fx.orgA,
        title: 'Teacher',
        employmentType: 'FULL_TIME' as const,
      };
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({
            data: { ...base, code: 'X1', positionId: orgBPosition.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({
            data: {
              ...base,
              code: 'X2',
              teamId: fx.teamA,
              organizationId: fx.orgB,
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({
            data: { ...base, code: 'X3', status: 'OPEN', openedAt: new Date() },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({ data: { ...base, code: 'x lower' } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({
            data: { ...base, code: 'X4', openingCount: 0 },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({
            data: { ...base, code: 'X5', compensationMin: '10' },
          }),
        ),
      ).toBeTruthy();
      // The hiring manager must work in the opening's organization.
      const orgBEmployee = await tx.employee.create({
        data: {
          personId: (await tx.person.create({ data: {} })).id,
          employeeNumber: `B-${fx.suffix}`,
          hireDate: new Date('2026-01-01'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: orgBEmployee.id,
          positionId: orgBPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
        },
      });
      expect(
        await violation(tx, () =>
          tx.jobOpening.create({
            data: {
              ...base,
              code: 'X6',
              hiringManagerEmployeeId: orgBEmployee.id,
            },
          }),
        ),
      ).toBeTruthy();
      const opening = await tx.jobOpening.create({
        data: { ...base, code: 'OK', hiringManagerEmployeeId: fx.employee2 },
      });
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { status: 'FILLED' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { code: 'OTHER' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { hiredCount: 1 },
          }),
        ),
      ).toBeTruthy();
      await tx.jobOpening.update({
        where: { id: opening.id },
        data: { status: 'OPEN', openedAt: new Date() },
      });
      // Hires are recorded one at a time; FILLED requires every opening hired.
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { status: 'FILLED' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { openingCount: 3, hiredCount: 2 },
          }),
        ),
      ).toBeTruthy();
      await tx.jobOpening.update({
        where: { id: opening.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { title: 'Renamed' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: opening.id },
            data: { status: 'OPEN', closedAt: null },
          }),
        ),
      ).toBeTruthy();
      const stage = await tx.recruitmentStage.create({
        data: {
          organizationId: fx.orgA,
          code: 'S1',
          name: 'S',
          kind: 'OTHER',
          sortOrder: 1,
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentStage.delete({ where: { id: stage.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentStage.update({
            where: { id: stage.id },
            data: { kind: 'HIRED' },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('guards candidates, applications and their history', async () => {
    await scenario(async (tx, fx) => {
      const { stage, opening, candidate } = await world(tx, fx);
      // Applications go to open openings only, and start active.
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.create({
            data: {
              organizationId: fx.orgA,
              candidateId: candidate.id,
              openingId: opening.id,
              stageId: stage.id,
              appliedAt: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
      await tx.jobOpening.update({
        where: { id: opening.id },
        data: { status: 'OPEN', openedAt: new Date() },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.create({
            data: {
              organizationId: fx.orgA,
              candidateId: candidate.id,
              openingId: opening.id,
              stageId: stage.id,
              appliedAt: new Date(),
              status: 'OFFERED',
            },
          }),
        ),
      ).toBeTruthy();
      const app = await tx.recruitmentApplication.create({
        data: {
          organizationId: fx.orgA,
          candidateId: candidate.id,
          openingId: opening.id,
          stageId: stage.id,
          appliedAt: new Date(),
        },
      });
      // HIRED only through a hire conversion; status moves follow the lifecycle.
      await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: { status: 'OFFERED' },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.update({
            where: { id: app.id },
            data: { status: 'HIRED' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.update({
            where: { id: app.id },
            data: { status: 'REJECTED' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentApplication.update({
            where: { id: app.id },
            data: { openingId: opening.id, appliedAt: new Date('2020-01-01') },
          }),
        ),
      ).toBeTruthy();
      // Candidates: an internal candidate is an employee of the organization; email is normalized.
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
      const orgBEmployee = await tx.employee.create({
        data: {
          personId: (await tx.person.create({ data: {} })).id,
          employeeNumber: `B-${fx.suffix}`,
          hireDate: new Date('2026-01-01'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: orgBEmployee.id,
          positionId: orgBPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.update({
            where: { id: candidate.id },
            data: { internalEmployeeId: orgBEmployee.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.update({
            where: { id: candidate.id },
            data: { organizationId: fx.orgB },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.delete({ where: { id: candidate.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.create({
            data: { organizationId: fx.orgA, firstName: ' ', lastName: 'X' },
          }),
        ),
      ).toBeTruthy();
      await tx.recruitmentCandidate.update({
        where: { id: candidate.id },
        data: {
          personId:
            fx.employee1 &&
            (
              await tx.employee.findUniqueOrThrow({
                where: { id: fx.employee1 },
              })
            ).personId,
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidate.update({
            where: { id: candidate.id },
            data: { personId: null },
          }),
        ),
      ).toBeTruthy();
      // Documents need a reference and keep it.
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidateDocument.create({
            data: {
              organizationId: fx.orgA,
              candidateId: candidate.id,
              kind: 'RESUME',
              title: 'CV',
              provider: 'EXTERNAL_URL',
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentCandidateDocument.create({
            data: {
              organizationId: fx.orgA,
              candidateId: candidate.id,
              kind: 'RESUME',
              title: 'CV',
              provider: 'EXTERNAL_URL',
              externalUrl: 'javascript:alert(1)',
            },
          }),
        ),
      ).toBeTruthy();
      // Screening only for live applications; transitions and activity are append-only.
      await tx.recruitmentScreening.create({
        data: { applicationId: app.id, outcome: 'ADVANCE' },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentScreening.deleteMany({
            where: { applicationId: app.id },
          }),
        ),
      ).toBeTruthy();
      const transition = await tx.recruitmentStageTransition.create({
        data: {
          applicationId: app.id,
          toStageId: stage.id,
          toStageName: 'Applied',
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentStageTransition.update({
            where: { id: transition.id },
            data: { toStageName: 'Other' },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('guards interviews, feedback revisions, offers and hires', async () => {
    await scenario(async (tx, fx) => {
      const { stage, opening, candidate } = await world(tx, fx);
      await tx.jobOpening.update({
        where: { id: opening.id },
        data: { status: 'OPEN', openedAt: new Date() },
      });
      const app = await tx.recruitmentApplication.create({
        data: {
          organizationId: fx.orgA,
          candidateId: candidate.id,
          openingId: opening.id,
          stageId: stage.id,
          appliedAt: new Date(),
        },
      });
      const interview = await tx.recruitmentInterview.create({
        data: {
          organizationId: fx.orgA,
          applicationId: app.id,
          type: 'VIDEO',
          title: 'Panel',
          scheduledStart: new Date(),
          durationMinutes: 30,
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentInterview.create({
            data: {
              organizationId: fx.orgA,
              applicationId: app.id,
              type: 'VIDEO',
              title: 'x',
              scheduledStart: new Date(),
              durationMinutes: 30,
              meetingUrl: 'http://insecure',
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentInterview.create({
            data: {
              organizationId: fx.orgB,
              applicationId: app.id,
              type: 'VIDEO',
              title: 'x',
              scheduledStart: new Date(),
              durationMinutes: 30,
            },
          }),
        ),
      ).toBeTruthy();
      const interviewer = await tx.recruitmentInterviewer.create({
        data: { interviewId: interview.id, userId: fx.selfUser2 },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewer.create({
            data: { interviewId: interview.id, userId: fx.selfUser2 },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewer.delete({ where: { id: interviewer.id } }),
        ),
      ).toBeTruthy();
      // Feedback: submitted is locked; a revision supersedes it; one current per interviewer.
      const submitted = await tx.recruitmentInterviewFeedback.create({
        data: {
          interviewId: interview.id,
          interviewerUserId: fx.selfUser2,
          status: 'SUBMITTED',
          recommendation: 'YES',
          submittedAt: new Date(),
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewFeedback.create({
            data: {
              interviewId: interview.id,
              interviewerUserId: fx.selfUser2,
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewFeedback.update({
            where: { id: submitted.id },
            data: { comments: 'edit' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewFeedback.create({
            data: {
              interviewId: interview.id,
              interviewerUserId: fx.selfUser2,
              revision: 2,
              supersedesFeedbackId: submitted.id,
              reopenReason: 'x',
            },
          }),
        ),
      ).toBeTruthy();
      await tx.recruitmentInterviewFeedback.update({
        where: { id: submitted.id },
        data: { supersededAt: new Date() },
      });
      await tx.recruitmentInterviewFeedback.create({
        data: {
          interviewId: interview.id,
          interviewerUserId: fx.selfUser2,
          revision: 2,
          supersedesFeedbackId: submitted.id,
          reopenReason: 'Wrong candidate',
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentInterviewFeedback.update({
            where: { id: submitted.id },
            data: { supersededAt: null },
          }),
        ),
      ).toBeTruthy();
      // Offers: on active applications, in-organization positions, one in progress.
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
      const offerData = {
        organizationId: fx.orgA,
        applicationId: app.id,
        positionId: fx.positionOrg,
        employmentType: 'FULL_TIME' as const,
        startDate: new Date('2026-04-01'),
        payBasis: 'SALARY' as const,
        rateAmount: '60000',
        currency: 'CAD',
      };
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.create({
            data: { ...offerData, positionId: orgBPosition.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.create({
            data: { ...offerData, rateAmount: '0' },
          }),
        ),
      ).toBeTruthy();
      const offer = await tx.recruitmentOffer.create({ data: offerData });
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.create({ data: offerData }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.update({
            where: { id: offer.id },
            data: { status: 'SENT', sentAt: new Date() },
          }),
        ),
      ).toBeTruthy();
      await tx.recruitmentOffer.update({
        where: { id: offer.id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.update({
            where: { id: offer.id },
            data: { currency: 'USD' },
          }),
        ),
      ).toBeTruthy();
      await tx.recruitmentOffer.update({
        where: { id: offer.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
      // A hire needs the accepted offer of an OFFERED application.
      const person = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee2 },
      });
      const hireData = {
        organizationId: fx.orgA,
        applicationId: app.id,
        offerId: offer.id,
        candidateId: candidate.id,
        openingId: opening.id,
        personId: person.personId,
        employeeId: fx.employee2,
        employmentAssignmentId: fx.orgLevel,
        internalCandidate: true,
        createdEmployee: false,
      };
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.create({ data: hireData }),
        ),
      ).toBeTruthy();
      await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: { status: 'OFFERED' },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.create({ data: hireData }),
        ),
      ).toBeTruthy();
      await tx.recruitmentOffer.update({
        where: { id: offer.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.create({
            data: { ...hireData, employeeId: fx.employee1 },
          }),
        ),
      ).toBeTruthy();
      const hire = await tx.recruitmentHire.create({ data: hireData });
      await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: { status: 'HIRED' },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.update({
            where: { id: hire.id },
            data: { internalCandidate: false },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.update({
            where: { id: offer.id },
            data: { internalNotes: 'late' },
          }),
        ),
      ).toBeTruthy();
      // Intake sources keep their identity; submissions keep their resolution.
      const source = await tx.recruitmentIntakeSource.create({
        data: {
          organizationId: fx.orgA,
          code: 'FORM',
          name: 'Form',
          provider: 'GOOGLE_FORMS',
          externalResourceId: 'form-1',
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSource.update({
            where: { id: source.id },
            data: { externalResourceId: 'form-2' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSource.create({
            data: {
              organizationId: fx.orgA,
              code: 'FORM2',
              name: 'Form',
              provider: 'GOOGLE_FORMS',
            },
          }),
        ),
      ).toBeTruthy();
      const sub = await tx.recruitmentIntakeSubmission.create({
        data: {
          organizationId: fx.orgA,
          sourceId: source.id,
          externalResponseId: 'r1',
          status: 'REJECTED',
          submission: {},
          contentHash: 'h',
          submittedAt: new Date(),
        },
      });
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSubmission.create({
            data: {
              organizationId: fx.orgA,
              sourceId: source.id,
              externalResponseId: 'r1',
              status: 'PENDING_OPENING',
              submission: {},
              contentHash: 'h',
              submittedAt: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSubmission.update({
            where: { id: sub.id },
            data: { status: 'PENDING_OPENING' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSubmission.create({
            data: {
              organizationId: fx.orgB,
              sourceId: source.id,
              externalResponseId: 'r2',
              status: 'PENDING_OPENING',
              submission: {},
              contentHash: 'h',
              submittedAt: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
    });
  });
});
