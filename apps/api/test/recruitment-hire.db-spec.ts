import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type {
  ExternalApplicationProvider,
  ExternalApplicationSubmission,
} from '../src/recruitment/recruitment-intake.contract.js';
import {
  expireRecruitmentOffers,
  syncRecruitmentApplications,
} from '../src/recruitment/recruitment-jobs.js';
import { failure } from './support/performance-fixtures.js';
import {
  acceptedOffer,
  candidateDetails,
  FixedRecruitmentClock,
  openOpening,
  detailOf,
  RECRUITMENT_USERS,
  recruitmentServices,
  vacantPosition,
  type RecruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const offerInput = (
  positionId: string,
  overrides: Record<string, unknown> = {},
) => ({
  positionId,
  employmentType: 'FULL_TIME' as const,
  startDate: '2026-04-01',
  payBasis: 'SALARY' as const,
  rateAmount: '62000.00',
  currency: 'CAD',
  expiresOn: '2026-03-25',
  ...overrides,
});

const submission = (
  id: string,
  overrides: Partial<ExternalApplicationSubmission> = {},
): ExternalApplicationSubmission => ({
  externalResponseId: id,
  submittedAt: '2026-03-10T14:00:00Z',
  openingCode: 'REQ-TEACH-1',
  candidate: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada.form@example.com',
  },
  answers: [
    { question: 'Do you hold an Ontario teaching certificate?', answer: 'Yes' },
  ],
  documents: [
    {
      kind: 'RESUME',
      title: 'Résumé',
      provider: 'GOOGLE_DRIVE',
      externalFileId: 'drive-file-1',
    },
  ],
  ...overrides,
});

describe('Recruitment offers, hire conversion and external intake (database)', () => {
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

  it('runs the offer lifecycle with separate approval, locked terms and date-derived expiry', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const recruiter = ctx(fx.users.recruiter!);
      const approver = ctx(fx.users.approver!);
      const position = await vacantPosition(tx, fx);
      const opening = await openOpening(svc, fx, { positionId: position });
      const app = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        recruiter,
      );
      expect(
        await failure(
          svc.offers.create(
            app.id,
            offerInput(position),
            ctx(fx.users.reader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.offers.create(
            app.id,
            offerInput(position, { rateAmount: '-1' }),
            recruiter,
          ),
        ),
      ).toMatchObject({ status: 400 });
      expect(
        await failure(
          svc.offers.create(
            app.id,
            offerInput(position, { expiresOn: '2026-03-01' }),
            recruiter,
          ),
        ),
      ).toEqual({ status: 400, code: 'RECRUITMENT_OFFER_EXPIRY_INVALID' });
      const offer = await svc.offers.create(
        app.id,
        offerInput(position, { internalNotes: 'Top of band' }),
        recruiter,
      );
      expect(offer).toMatchObject({
        status: 'DRAFT',
        rateAmount: '62000.0000',
        currency: 'CAD',
        payBasis: 'SALARY',
      });
      expect(
        await failure(
          svc.offers.create(app.id, offerInput(position), recruiter),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_OFFER_IN_PROGRESS' });
      await svc.offers.update(offer.id, { rateAmount: '64000' }, recruiter);
      // Approval is a separate permission; recruitment.manage alone never approves.
      expect(
        await failure(svc.offers.act(offer.id, 'approve', null, recruiter)),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.offers.act(offer.id, 'send', null, recruiter)),
      ).toEqual({ status: 409, code: 'RECRUITMENT_OFFER_TRANSITION_INVALID' });
      await svc.offers.act(offer.id, 'approve', null, approver);
      expect(
        await failure(
          svc.offers.update(offer.id, { rateAmount: '70000' }, recruiter),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_OFFER_LOCKED' });
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.update({
            where: { id: offer.id },
            data: { rateAmount: '70000' },
          }),
        ),
      ).toBeTruthy();
      // Revising returns it to draft and clears the approval.
      const revised = await svc.offers.act(offer.id, 'revise', null, recruiter);
      expect(revised).toMatchObject({ status: 'DRAFT', approvedAt: null });
      await svc.offers.update(offer.id, { startDate: '2026-04-06' }, recruiter);
      await svc.offers.act(offer.id, 'approve', null, approver);
      await svc.offers.act(offer.id, 'send', null, recruiter);
      expect(
        (
          await tx.recruitmentApplication.findUniqueOrThrow({
            where: { id: app.id },
          })
        ).status,
      ).toBe('OFFERED');
      // The offer expires by date: after 2026-03-25 it reads EXPIRED and can no longer be accepted.
      clock.value = new Date('2026-03-26T16:00:00.000Z');
      expect(
        (await detailOf(svc, fx.users.reader!, app.id)).offers![0],
      ).toMatchObject({ status: 'SENT', effectiveStatus: 'EXPIRED' });
      expect(
        await failure(svc.offers.act(offer.id, 'accept', null, recruiter)),
      ).toEqual({ status: 409, code: 'RECRUITMENT_OFFER_EXPIRED' });
      // The expiry job only records it (idempotently) and returns the application to active.
      const run = await expireRecruitmentOffers(rollbackClient(tx), clock);
      expect(run).toMatchObject({ expired: 1, failed: [] });
      expect(
        (await expireRecruitmentOffers(rollbackClient(tx), clock)).expired,
      ).toBe(0);
      expect(
        await tx.recruitmentOffer.findUniqueOrThrow({
          where: { id: offer.id },
        }),
      ).toMatchObject({ status: 'EXPIRED' });
      expect(
        (
          await tx.recruitmentApplication.findUniqueOrThrow({
            where: { id: app.id },
          })
        ).status,
      ).toBe('ACTIVE');
      // A new offer, declined: the application returns to active again; history keeps both.
      const second = await svc.offers.create(
        app.id,
        offerInput(position, { expiresOn: '2026-04-01' }),
        recruiter,
      );
      await svc.offers.act(second.id, 'approve', null, approver);
      await svc.offers.act(second.id, 'send', null, recruiter);
      expect(
        await failure(svc.offers.act(second.id, 'decline', null, recruiter)),
      ).toEqual({ status: 400, code: 'RECRUITMENT_REASON_REQUIRED' });
      await svc.offers.act(
        second.id,
        'decline',
        'Accepted a closer school',
        recruiter,
      );
      expect(
        (
          await tx.recruitmentApplication.findUniqueOrThrow({
            where: { id: app.id },
          })
        ).status,
      ).toBe('ACTIVE');
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.update({
            where: { id: second.id },
            data: { status: 'ACCEPTED' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentOffer.delete({ where: { id: second.id } }),
        ),
      ).toBeTruthy();
      const types = (
        await detailOf(svc, fx.users.reader!, app.id)
      ).activity!.map((row) => row.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'OFFER_CREATED',
          'OFFER_APPROVED',
          'OFFER_REVISED',
          'OFFER_SENT',
          'OFFER_EXPIRED',
          'OFFER_DECLINED',
        ]),
      );
      // Offer amounts and terms never reach the audit log.
      const audits = await tx.auditLog.findMany({
        where: { entityType: 'RecruitmentOffer' },
      });
      expect(JSON.stringify(audits.map((row) => row.metadata))).not.toMatch(
        /62000|64000|Top of band|closer school/,
      );
    });
  });

  it('converts an accepted offer to an employee through Core HR, once', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const position = await vacantPosition(tx, fx);
      const { applicationId, candidateId, offerId, openingId } =
        await acceptedOffer(svc, fx, { positionId: position });
      // Recruitment permissions are not enough: Core HR's employee.manage is required too.
      expect(
        await failure(
          svc.hires.convert(
            applicationId,
            {},
            ctx(fx.users.hirerWithoutCoreHr!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.hires.convert(applicationId, {}, ctx(fx.users.hr!))),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.hires.convert(applicationId, {}, ctx(fx.users.recruiter!)),
        ),
      ).toMatchObject({ status: 403 });
      const hire = await svc.hires.convert(
        applicationId,
        { initializeCompensation: true },
        admin,
      );
      expect(hire).toMatchObject({
        createdEmployee: true,
        internalCandidate: false,
        assignment: { status: 'PLANNED', startDate: '2026-04-01' },
        opening: { status: 'FILLED', hiredCount: 1 },
      });
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: hire.employeeId },
        include: { person: true, assignments: true },
      });
      expect(employee).toMatchObject({
        status: 'ACTIVE',
        hireDate: new Date('2026-04-01T00:00:00.000Z'),
      });
      expect(employee.person).toMatchObject({
        firstName: 'Ada',
        lastName: 'Lovelace',
        personalEmail: 'ada.candidate@example.com',
      });
      expect(employee.assignments).toEqual([
        expect.objectContaining({
          id: hire.employmentAssignmentId,
          positionId: position,
          employmentType: 'FULL_TIME',
          isPrimary: true,
        }),
      ]);
      // Compensation initialized through the Compensation domain (an INITIAL record).
      expect(
        await tx.compensationRecord.findUniqueOrThrow({
          where: { id: hire.compensationRecordId! },
        }),
      ).toMatchObject({
        employmentAssignmentId: hire.employmentAssignmentId,
        recordType: 'INITIAL',
        payBasis: 'SALARY',
        currency: 'CAD',
        effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
      });
      // Permanent links.
      expect(
        await tx.recruitmentCandidate.findUniqueOrThrow({
          where: { id: candidateId },
        }),
      ).toMatchObject({ personId: employee.personId });
      const app = await detailOf(svc, fx.users.reader!, applicationId);
      expect({
        status: app.status,
        stage: app.stage.kind,
        hire: app.hire?.employeeId,
      }).toEqual({ status: 'HIRED', stage: 'HIRED', hire: hire.employeeId });
      expect(app.activity![0]!.type).toBe('HIRED');
      // Never twice (service, unique constraints and the immutable hire row).
      expect(
        await failure(svc.hires.convert(applicationId, {}, admin)),
      ).toEqual({ status: 409, code: 'RECRUITMENT_ALREADY_HIRED' });
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.update({
            where: { id: hire.id },
            data: { compensationRecordId: null },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.delete({ where: { id: hire.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentHire.create({
            data: {
              organizationId: fx.orgA,
              applicationId,
              offerId,
              candidateId,
              openingId,
              personId: employee.personId,
              employeeId: hire.employeeId,
              employmentAssignmentId: hire.employmentAssignmentId,
              internalCandidate: false,
              createdEmployee: false,
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.jobOpening.update({
            where: { id: openingId },
            data: { hiredCount: 0 },
          }),
        ),
      ).toBeTruthy();
      // Audits: the conversion and Core HR's own records; no personal details in recruitment metadata.
      const audits = await tx.auditLog.findMany({
        where: { actorUserId: fx.users.hiringAdmin! },
      });
      expect(audits.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'PERSON_CREATED',
          'EMPLOYEE_CREATED',
          'EMPLOYMENT_ASSIGNMENT_CREATED',
          'COMPENSATION_CREATED',
          'RECRUITMENT_HIRE_CONVERTED',
        ]),
      );
      const conversion = audits.find(
        (row) => row.action === 'RECRUITMENT_HIRE_CONVERTED',
      )!;
      expect(JSON.stringify(conversion.metadata)).not.toMatch(
        /Ada|Lovelace|example\.com|62000/,
      );
      // A filled opening accepts a new hire only after an opening is added (it reopens).
      expect(
        (await tx.jobOpening.findUniqueOrThrow({ where: { id: openingId } }))
          .status,
      ).toBe('FILLED');
      await svc.openings.update(openingId, { openingCount: 2 }, admin);
      expect(
        (await tx.jobOpening.findUniqueOrThrow({ where: { id: openingId } }))
          .status,
      ).toBe('OPEN');
      expect(
        await failure(
          svc.openings.update(openingId, { openingCount: 0 }, admin),
        ),
      ).toMatchObject({ status: 400 });
    });
  });

  it('refuses incomplete hires and reuses existing employees only explicitly', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const position = await vacantPosition(tx, fx);
      const opening = await openOpening(svc, fx, {
        positionId: position,
        openingCount: 3,
      });
      const app = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        admin,
      );
      expect(await failure(svc.hires.convert(app.id, {}, admin))).toEqual({
        status: 409,
        code: 'RECRUITMENT_HIRE_NOT_READY',
      });
      // An employee already uses the candidate's email: refuse a silent duplicate person.
      const existingUser = await tx.user.findUniqueOrThrow({
        where: { id: fx.selfUser1 },
      });
      const known = await acceptedOffer(svc, fx, {
        positionId: position,
        openingId: opening.id,
        candidate: { email: existingUser.email, firstName: 'Employee1' },
      });
      const refused = await failure(
        svc.hires.convert(known.applicationId, {}, admin),
      );
      expect(refused).toEqual({
        status: 409,
        code: 'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE',
      });
      // Explicit reuse of the existing employee (e.g. a returning employee): no new person.
      const reused = await svc.hires.convert(
        known.applicationId,
        { existingEmployeeId: fx.employee1, isPrimary: false },
        admin,
      );
      expect(reused).toMatchObject({
        employeeId: fx.employee1,
        createdEmployee: false,
        compensationRecordId: null,
        opening: { status: 'OPEN', hiredCount: 1 },
      });
      // An internal candidate is hired as themselves (a new assignment, same employee).
      const position2 = await vacantPosition(tx, fx);
      const internal = await acceptedOffer(svc, fx, {
        positionId: position2,
        openingId: opening.id,
        candidate: {
          email: 'employee2.internal@example.com',
          firstName: 'Employee2',
        },
      });
      await tx.recruitmentCandidate.update({
        where: { id: internal.candidateId },
        data: { internalEmployeeId: fx.employee2 },
      });
      expect(
        await failure(
          svc.hires.convert(
            internal.applicationId,
            { existingEmployeeId: fx.employee1 },
            admin,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'RECRUITMENT_HIRE_EMPLOYEE_MISMATCH',
      });
      const internalHire = await svc.hires.convert(
        internal.applicationId,
        {},
        admin,
      );
      expect(internalHire).toMatchObject({
        employeeId: fx.employee2,
        internalCandidate: true,
        createdEmployee: false,
      });
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: internalHire.employmentAssignmentId },
        }),
      ).toMatchObject({ isPrimary: false, positionId: position2 });
      // Core HR's own rules still apply: an occupied position cannot be assigned again.
      const third = await acceptedOffer(svc, fx, {
        positionId: position2,
        openingId: opening.id,
        candidate: { email: 'third@example.com' },
      });
      expect(
        await failure(svc.hires.convert(third.applicationId, {}, admin)),
      ).toMatchObject({ status: 409 });
      expect(
        await tx.recruitmentHire.count({
          where: { applicationId: third.applicationId },
        }),
      ).toBe(0);
    });
  });

  it('ingests external applications idempotently with corrections and an opening queue', async () => {
    await scenario(async (tx, fx, svc) => {
      const intake = ctx(fx.users.intakeAdmin!);
      const opening = await openOpening(svc, fx);
      for (const user of ['recruiter', 'teamPipeline', 'hr', 'orgBAdmin']) {
        expect(
          await failure(
            svc.intake.createSource(
              {
                organizationId: fx.orgA,
                code: 'staff-form',
                name: 'Staff application',
                provider: 'GOOGLE_FORMS',
                externalResourceId: 'form-1',
              },
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      expect(
        await failure(
          svc.intake.createSource(
            {
              organizationId: fx.orgA,
              code: 'staff-form',
              name: 'Staff application',
              provider: 'GOOGLE_FORMS',
            },
            intake,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'RECRUITMENT_SOURCE_RESOURCE_REQUIRED',
      });
      const source = await svc.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'staff-form',
          name: 'Staff application',
          provider: 'GOOGLE_FORMS',
          externalResourceId: 'form-1',
        },
        intake,
      );
      expect(
        await failure(
          svc.intake.createSource(
            {
              organizationId: fx.orgA,
              code: 'again',
              name: 'x',
              provider: 'GOOGLE_FORMS',
              externalResourceId: 'form-1',
            },
            intake,
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'RECRUITMENT_SOURCE_EXISTS',
      });
      expect(
        await failure(
          svc.intake.ingest(
            source.id,
            [submission('r1')],
            'IMPORT',
            fx.users.recruiter!,
          ),
        ),
      ).toMatchObject({ status: 403 });
      const first = await svc.intake.ingest(
        source.id,
        [
          submission('r1'),
          submission('r2', {
            openingCode: null,
            candidate: {
              firstName: 'Grace',
              lastName: 'Hopper',
              email: 'grace@example.com',
            },
          }),
          submission('r3', {
            candidate: { firstName: '', lastName: 'Nameless' },
          }),
          submission('r4', {
            openingCode: 'NO-SUCH-REQ',
            candidate: {
              firstName: 'Alan',
              lastName: 'Turing',
              email: 'alan@example.com',
            },
          }),
        ],
        'IMPORT',
        fx.users.intakeAdmin!,
      );
      expect(
        first.outcomes.map((row) => [
          row.externalResponseId,
          row.outcome,
          row.reason ?? null,
        ]),
      ).toEqual([
        ['r1', 'CREATED', null],
        ['r2', 'PENDING_OPENING', 'NO_OPENING'],
        ['r3', 'REJECTED', 'RECRUITMENT_TEXT_REQUIRED'],
        ['r4', 'PENDING_OPENING', 'OPENING_NOT_FOUND'],
      ]);
      const created = first.outcomes[0]!;
      const application = await detailOf(
        svc,
        fx.users.recruiter!,
        created.applicationId!,
      );
      expect(application).toMatchObject({
        source: 'EXTERNAL_FORM',
        stage: { kind: 'APPLIED' },
        candidate: { email: 'ada.form@example.com', source: 'EXTERNAL_FORM' },
      });
      expect(application.documents.map((doc) => doc.externalFileId)).toEqual([
        'drive-file-1',
      ]);
      // Re-delivery is a no-op; older content is stale; changed content is a correction.
      const again = await svc.intake.ingest(
        source.id,
        [submission('r1')],
        'SYNC',
        null,
      );
      expect(again.outcomes[0]).toMatchObject({
        outcome: 'UNCHANGED',
        applicationId: created.applicationId,
      });
      const corrected = await svc.intake.ingest(
        source.id,
        [
          submission('r1', {
            externalUpdatedAt: '2026-03-11T10:00:00Z',
            answers: [
              {
                question: 'Do you hold an Ontario teaching certificate?',
                answer: 'In progress',
              },
            ],
            documents: [
              {
                kind: 'COVER_LETTER',
                title: 'Letter',
                provider: 'EXTERNAL_URL',
                externalUrl: 'https://drive.example.com/letter',
              },
            ],
          }),
        ],
        'SYNC',
        null,
      );
      expect(corrected.outcomes[0]).toMatchObject({
        outcome: 'CORRECTED',
        applicationId: created.applicationId,
      });
      const stale = await svc.intake.ingest(
        source.id,
        [
          submission('r1', {
            externalUpdatedAt: '2026-03-10T15:00:00Z',
            answers: [],
          }),
        ],
        'SYNC',
        null,
      );
      expect(stale.outcomes[0]).toMatchObject({ outcome: 'STALE' });
      expect(
        await tx.recruitmentApplication.count({
          where: { candidateId: created.candidateId },
        }),
      ).toBe(1);
      expect(
        await tx.recruitmentCandidateDocument.count({
          where: { applicationId: created.applicationId },
        }),
      ).toBe(2);
      const stored = await tx.recruitmentIntakeSubmission.findFirstOrThrow({
        where: { sourceId: source.id, externalResponseId: 'r1' },
      });
      expect(stored).toMatchObject({ status: 'APPLIED', correctionCount: 1 });
      expect(JSON.stringify(stored.submission)).toContain('In progress');
      // A second response from the same person to the same opening attaches, never duplicates.
      const duplicate = await svc.intake.ingest(
        source.id,
        [
          submission('r5', {
            candidate: {
              firstName: 'A.',
              lastName: 'Lovelace',
              email: 'ADA.FORM@example.com',
            },
          }),
        ],
        'SYNC',
        null,
      );
      expect(duplicate.outcomes[0]).toMatchObject({
        outcome: 'ATTACHED',
        applicationId: created.applicationId,
        reason: 'EXISTING_APPLICATION',
      });
      // The unmatched opening queue: HR assigns or rejects.
      const queue = await svc.intake.queue(fx.users.intakeAdmin!, fx.orgA);
      expect(queue.items.map((row) => row.externalResponseId).sort()).toEqual([
        'r2',
        'r4',
      ]);
      queue.items.sort((a, b) =>
        a.externalResponseId.localeCompare(b.externalResponseId),
      );
      expect(
        await failure(svc.intake.queue(fx.users.recruiter!, fx.orgA)),
      ).toMatchObject({ status: 403 });
      const assigned = await svc.intake.assignOpening(
        queue.items[0]!.id,
        opening.id,
        intake,
      );
      expect(assigned).toMatchObject({ outcome: 'CREATED' });
      expect(
        await failure(
          svc.intake.assignOpening(queue.items[0]!.id, opening.id, intake),
        ),
      ).toEqual({ status: 409, code: 'RECRUITMENT_INTAKE_RESOLVED' });
      await svc.intake.rejectSubmission(
        queue.items[1]!.id,
        'Not a staff application',
        intake,
      );
      expect(
        (
          await svc.intake.ingest(
            source.id,
            [
              submission('r4', {
                openingCode: 'REQ-TEACH-1',
                candidate: {
                  firstName: 'Alan',
                  lastName: 'Turing',
                  email: 'alan@example.com',
                },
              }),
            ],
            'SYNC',
            null,
          )
        ).outcomes[0],
      ).toMatchObject({
        outcome: 'REJECTED',
        reason: 'PREVIOUSLY_REJECTED',
      });
      // Organization isolation: another organization's opening code never resolves.
      const orgBOpening = await svc.openings.create(
        {
          organizationId: fx.orgB,
          code: 'B-REQ',
          title: 'B',
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
      const crossOrg = await svc.intake.ingest(
        source.id,
        [
          submission('r6', {
            openingCode: 'B-REQ',
            candidate: {
              firstName: 'Bo',
              lastName: 'B',
              email: 'bo@example.com',
            },
          }),
        ],
        'SYNC',
        null,
      );
      expect(crossOrg.outcomes[0]).toMatchObject({
        outcome: 'PENDING_OPENING',
        reason: 'OPENING_NOT_FOUND',
      });
      expect(
        await failure(
          svc.intake.assignOpening(
            crossOrg.outcomes[0]!.submissionId!,
            orgBOpening.id,
            intake,
          ),
        ),
      ).toMatchObject({ status: 404 });
      // Stored submissions are normalized fields only, and resolved ones never change identity.
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSubmission.update({
            where: { id: stored.id },
            data: { status: 'PENDING_OPENING' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.recruitmentIntakeSubmission.delete({ where: { id: stored.id } }),
        ),
      ).toBeTruthy();
      const ingestAudit = await tx.auditLog.findMany({
        where: { action: 'RECRUITMENT_APPLICATIONS_INGESTED' },
      });
      expect(
        JSON.stringify(ingestAudit.map((row) => row.metadata)),
      ).not.toMatch(/Ada|Lovelace|certificate|example\.com/);
      // Synchronization records its state on the source.
      expect(
        (
          await tx.recruitmentIntakeSource.findUniqueOrThrow({
            where: { id: source.id },
          })
        ).lastSyncStatus,
      ).toBe('OK');
    });
  });

  it('feeds provider adapters through the ingestion contract (none registered in Phase 13)', async () => {
    await scenario(async (tx, fx, svc) => {
      await openOpening(svc, fx);
      const source = await svc.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'staff-form',
          name: 'Staff application',
          provider: 'GOOGLE_FORMS',
          externalResourceId: 'form-sync',
        },
        ctx(fx.users.intakeAdmin!),
      );
      const client = rollbackClient(tx);
      expect(await syncRecruitmentApplications(client)).toMatchObject({
        sources: 1,
        synced: 0,
        skipped: 1,
        failed: [],
      });
      const calls: Array<Date | null> = [];
      const adapter: ExternalApplicationProvider = {
        provider: 'GOOGLE_FORMS',
        fetchSubmissions: async (target, since) => {
          expect(target.externalResourceId).toBe('form-sync');
          calls.push(since);
          return [submission('sync-1')];
        },
      };
      expect(
        await syncRecruitmentApplications(client, [adapter]),
      ).toMatchObject({ synced: 1, received: 1 });
      expect(
        await syncRecruitmentApplications(client, [adapter]),
      ).toMatchObject({ synced: 1, received: 1 });
      expect(calls[0]).toBeNull();
      expect(calls[1]).toBeInstanceOf(Date);
      expect(
        await tx.recruitmentApplication.count({
          where: { organizationId: fx.orgA, source: 'EXTERNAL_FORM' },
        }),
      ).toBe(1);
      const failing: ExternalApplicationProvider = {
        provider: 'GOOGLE_FORMS',
        fetchSubmissions: async () => {
          throw new Error('quota exceeded');
        },
      };
      expect(
        await syncRecruitmentApplications(client, [failing]),
      ).toMatchObject({
        failed: [{ sourceId: source.id, message: 'quota exceeded' }],
      });
      expect(
        await tx.recruitmentIntakeSource.findUniqueOrThrow({
          where: { id: source.id },
        }),
      ).toMatchObject({ lastSyncStatus: 'FAILED' });
    });
  });
});

describe('Recruitment concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: RecruitmentServices;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, RECRUITMENT_USERS),
      { timeout: 60_000 },
    );
    svc = recruitmentServices(prisma, new FixedRecruitmentClock());
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('keeps one application when the same external response is delivered concurrently', async () => {
    const opening = await openOpening(svc, fx, {
      code: `REQ-DUP-${fx.suffix}`,
    });
    const source = await svc.intake.createSource(
      {
        organizationId: fx.orgA,
        code: `form-${fx.suffix}`,
        name: 'Form',
        provider: 'GOOGLE_FORMS',
        externalResourceId: `form-${fx.suffix}`,
      },
      ctx(fx.users.intakeAdmin!),
    );
    const deliveries = await Promise.all(
      [0, 1, 2, 3].map(() =>
        svc.intake.ingest(
          source.id,
          [
            submission('dup-1', {
              openingCode: opening.code,
              candidate: {
                firstName: 'Dup',
                lastName: 'Licate',
                email: `dup-${fx.suffix}@example.com`,
              },
            }),
          ],
          'SYNC',
          null,
        ),
      ),
    );
    expect(deliveries.map((d) => d.outcomes[0]!.outcome).sort()).toEqual([
      'CREATED',
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
    ]);
    expect(
      await prisma.recruitmentApplication.count({
        where: { openingId: opening.id },
      }),
    ).toBe(1);
    expect(
      await prisma.recruitmentCandidate.count({
        where: {
          organizationId: fx.orgA,
          normalizedEmail: `dup-${fx.suffix}@example.com`.toLowerCase(),
        },
      }),
    ).toBe(1);
  });

  it('keeps one candidate when two different responses of the same email arrive concurrently', async () => {
    const opening = await openOpening(svc, fx, { code: `REQ-EM-${fx.suffix}` });
    const [s1, s2] = await Promise.all(
      ['a', 'b'].map((code) =>
        svc.intake.createSource(
          {
            organizationId: fx.orgA,
            code: `src-${code}-${fx.suffix}`,
            name: code,
            provider: 'GOOGLE_FORMS',
            externalResourceId: `res-${code}-${fx.suffix}`,
          },
          ctx(fx.users.intakeAdmin!),
        ),
      ),
    );
    const email = `same-${fx.suffix}@example.com`.toLowerCase();
    const results = await Promise.all(
      [s1!, s2!].map((source, index) =>
        svc.intake.ingest(
          source.id,
          [
            submission(`resp-${index}`, {
              openingCode: opening.code,
              candidate: { firstName: 'Same', lastName: 'Person', email },
            }),
          ],
          'SYNC',
          null,
        ),
      ),
    );
    expect(results.map((r) => r.outcomes[0]!.outcome).sort()).toEqual([
      'ATTACHED',
      'CREATED',
    ]);
    expect(
      await prisma.recruitmentCandidate.count({
        where: { organizationId: fx.orgA, normalizedEmail: email },
      }),
    ).toBe(1);
    expect(
      await prisma.recruitmentApplication.count({
        where: { openingId: opening.id },
      }),
    ).toBe(1);
  });

  it('converts an application once when two admins hire it at the same time', async () => {
    const position = await prisma.$transaction((tx) =>
      vacantPosition(tx, fx, { code: `VAC-A-${fx.suffix}` }),
    );
    const { applicationId } = await acceptedOffer(svc, fx, {
      positionId: position,
      openingOverrides: { code: `REQ-HIRE-${fx.suffix}`, openingCount: 2 },
      candidate: { email: `hire-${fx.suffix}@example.com` },
    });
    const results = await Promise.allSettled([
      svc.hires.convert(applicationId, {}, ctx(fx.users.hiringAdmin!)),
      svc.hires.convert(applicationId, {}, ctx(fx.users.hiringAdmin!)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(await failure(Promise.reject(rejected.reason))).toEqual({
      status: 409,
      code: 'RECRUITMENT_ALREADY_HIRED',
    });
    expect(
      await prisma.recruitmentHire.count({ where: { applicationId } }),
    ).toBe(1);
    expect(
      await prisma.employee.count({
        where: { person: { personalEmail: `hire-${fx.suffix}@example.com` } },
      }),
    ).toBe(1);
  });

  it('fills the last remaining opening only once', async () => {
    const [p1, p2] = await prisma.$transaction(async (tx) => [
      await vacantPosition(tx, fx, { code: `VAC-L1-${fx.suffix}` }),
      await vacantPosition(tx, fx, { code: `VAC-L2-${fx.suffix}` }),
    ]);
    const first = await acceptedOffer(svc, fx, {
      positionId: p1!,
      openingOverrides: { code: `REQ-LAST-${fx.suffix}`, openingCount: 1 },
      candidate: { email: `last1-${fx.suffix}@example.com` },
    });
    const second = await acceptedOffer(svc, fx, {
      positionId: p2!,
      openingId: first.openingId,
      candidate: { email: `last2-${fx.suffix}@example.com` },
    });
    const results = await Promise.allSettled([
      svc.hires.convert(first.applicationId, {}, ctx(fx.users.hiringAdmin!)),
      svc.hires.convert(second.applicationId, {}, ctx(fx.users.hiringAdmin!)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(await failure(Promise.reject(rejected.reason))).toEqual({
      status: 409,
      code: 'RECRUITMENT_OPENING_FILLED',
    });
    expect(
      await prisma.jobOpening.findUniqueOrThrow({
        where: { id: first.openingId },
      }),
    ).toMatchObject({ status: 'FILLED', hiredCount: 1 });
    expect(
      await prisma.recruitmentHire.count({
        where: { openingId: first.openingId },
      }),
    ).toBe(1);
  });

  it('serializes accepting and withdrawing the same offer', async () => {
    const position = await prisma.$transaction((tx) =>
      vacantPosition(tx, fx, { code: `VAC-O-${fx.suffix}` }),
    );
    const opening = await openOpening(svc, fx, {
      code: `REQ-OFF-${fx.suffix}`,
      positionId: position,
    });
    const admin = ctx(fx.users.hiringAdmin!);
    const app = await svc.applications.create(
      {
        openingId: opening.id,
        candidate: candidateDetails({
          email: `offer-${fx.suffix}@example.com`,
        }),
      },
      admin,
    );
    const offer = await svc.offers.create(app.id, offerInput(position), admin);
    await svc.offers.act(offer.id, 'approve', null, admin);
    await svc.offers.act(offer.id, 'send', null, admin);
    const results = await Promise.allSettled([
      svc.offers.act(offer.id, 'accept', null, admin),
      svc.offers.act(offer.id, 'withdraw', 'Budget frozen', admin),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const final = await prisma.recruitmentOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    const application = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: app.id },
    });
    // Consistent either way: accepted keeps the application offered; withdrawn returns it to active.
    expect([final.status, application.status]).toEqual(
      final.status === 'ACCEPTED'
        ? ['ACCEPTED', 'OFFERED']
        : ['WITHDRAWN', 'ACTIVE'],
    );
  });
});
