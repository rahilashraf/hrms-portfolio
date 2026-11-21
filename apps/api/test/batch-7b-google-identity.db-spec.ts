import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  connectOAuth,
  FixedGoogleClock,
  formInfo,
  formResponse,
  GOOGLE_USERS,
  googleTestServices,
  type GoogleTestServices,
} from './support/google-fixtures.js';
import {
  activeTemplate,
  FixedOnboardingClock,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import { vacantPosition } from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const emailOf = async (tx: Tx, userId: string) =>
  (await tx.user.findUniqueOrThrow({ where: { id: userId } })).email;
/** A mapping whose "First name" question is (mis)used as an email question. */
const MAPPED_EMAIL = {
  schemaVersion: 1,
  fields: [{ questionId: 'q-first', field: 'respondentEmail' }],
};
const typed = (email: string) => ({
  answers: { 'q-first': { texts: [email], files: [] } },
});

/**
 * Batch 7B (S4/D1): Google Forms respondent identity. Only the email Google collected with
 * verified collection associates a response with an employee; a typed or mapped email is never
 * proof of identity. Performance results without trusted identity wait in the unmatched queue
 * for HR; onboarding tasks are never completed from them. Bindings of forms that do not verify
 * emails are refused when created or edited, and existing ones are flagged.
 */
describe('Batch 7B Google Forms respondent identity (database)', () => {
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
      svc: GoogleTestServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, GOOGLE_USERS);
          const svc = googleTestServices(
            rollbackClient(tx),
            new FixedGoogleClock(),
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

  it('performance evidence: only verified collected emails match; spoofed, missing and unverified identities wait for HR', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.googleAdmin!);
      const formId = `perf-identity-${fx.suffix}`;
      const source = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: fx.orgA,
          code: 'ID-QUIZ',
          name: 'Identity quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: formId,
          passThresholdPercent: '50',
        },
      });
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      const create = () =>
        svc.bindings.create(
          {
            organizationId: fx.orgA,
            formId,
            target: 'PERFORMANCE_EVIDENCE',
            performanceSourceId: source.id,
            mapping: MAPPED_EMAIL,
          },
          admin,
        );
      // New bindings need verified email collection.
      for (const emailCollection of ['DO_NOT_COLLECT', 'RESPONDER_INPUT']) {
        svc.fake.forms.set(formId, formInfo(formId, { emailCollection }));
        expect(await failure(create())).toEqual({
          status: 400,
          code: 'GOOGLE_FORM_EMAIL_NOT_VERIFIED',
        });
      }
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await create();
      const employee1 = await emailOf(tx, fx.selfUser1);
      const colleague = await emailOf(tx, fx.selfUser2);
      svc.fake.responses.set(formId, [
        // Verified: Employee 1's own response, whatever they typed.
        formResponse('verified', '2026-10-06T09:00:00Z', {
          respondentEmail: employee1,
          totalScore: 8,
          ...typed(colleague),
        }),
        // Spoofed: no collected email, the colleague's email typed in.
        formResponse('spoofed', '2026-10-06T09:01:00Z', {
          respondentEmail: null,
          totalScore: 10,
          ...typed(colleague),
        }),
        // Mismatched: a verified stranger typing the colleague's email.
        formResponse('mismatched', '2026-10-06T09:02:00Z', {
          respondentEmail: 'stranger@example.com',
          totalScore: 10,
          ...typed(colleague),
        }),
        // Missing: nothing at all.
        formResponse('missing', '2026-10-06T09:03:00Z', { totalScore: 3 }),
      ]);
      expect(await svc.sync.syncManually(binding.id, admin)).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 4,
      });
      const evidence = await tx.performanceEvidence.findMany({
        where: { sourceId: source.id },
        select: { externalResultId: true, employeeId: true },
      });
      expect(evidence).toEqual([
        { externalResultId: 'verified', employeeId: fx.employee1 },
      ]);
      // Nothing reached the colleague; the rest waits for HR with the claim kept for review.
      expect(
        await tx.performanceEvidence.count({
          where: { employeeId: fx.employee2 },
        }),
      ).toBe(0);
      const intake = await tx.performanceEvidenceIntake.findMany({
        where: { sourceId: source.id },
        orderBy: { externalResultId: 'asc' },
        select: {
          externalResultId: true,
          respondentEmail: true,
          respondentReference: true,
          status: true,
        },
      });
      expect(intake).toEqual([
        {
          externalResultId: 'mismatched',
          respondentEmail: 'stranger@example.com',
          respondentReference: `Unverified email: ${colleague}`,
          status: 'PENDING_MATCH',
        },
        {
          externalResultId: 'missing',
          respondentEmail: null,
          respondentReference: null,
          status: 'PENDING_MATCH',
        },
        {
          externalResultId: 'spoofed',
          respondentEmail: null,
          respondentReference: `Unverified email: ${colleague}`,
          status: 'PENDING_MATCH',
        },
      ]);
      expect(
        (
          await tx.googleFormBinding.findUniqueOrThrow({
            where: { id: binding.id },
          })
        ).lastErrorCode,
      ).toBeNull();
    });
  });

  it('an existing binding of a form that stops verifying emails keeps syncing safely and is flagged', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.googleAdmin!);
      const formId = `perf-legacy-${fx.suffix}`;
      const source = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: fx.orgA,
          code: 'LEGACY-QUIZ',
          name: 'Legacy quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: formId,
        },
      });
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'PERFORMANCE_EVIDENCE',
          performanceSourceId: source.id,
          mapping: { schemaVersion: 1, fields: [] },
        },
        admin,
      );
      // Later, the form owner switches to respondent-typed emails.
      svc.fake.forms.set(
        formId,
        formInfo(formId, { emailCollection: 'RESPONDER_INPUT' }),
      );
      const employee1 = await emailOf(tx, fx.selfUser1);
      svc.fake.responses.set(formId, [
        formResponse('typed', '2026-10-06T09:00:00Z', {
          respondentEmail: employee1,
          totalScore: 8,
        }),
      ]);
      const run = await svc.sync.syncManually(binding.id, admin);
      expect(run).toMatchObject({
        status: 'SUCCEEDED',
        warningCode: 'GOOGLE_FORM_IDENTITY_UNVERIFIED',
      });
      expect(
        await tx.performanceEvidence.count({ where: { sourceId: source.id } }),
      ).toBe(0);
      expect(
        await tx.performanceEvidenceIntake.findFirstOrThrow({
          where: { sourceId: source.id },
        }),
      ).toMatchObject({
        respondentEmail: null,
        respondentReference: `Unverified email: ${employee1}`,
      });
      const listed = (
        await svc.bindings.list(fx.users.googleAdmin!, fx.orgA)
      ).items.find((item) => item.id === binding.id)!;
      expect(listed).toMatchObject({
        lastErrorCode: 'GOOGLE_FORM_IDENTITY_UNVERIFIED',
        identityWarning: 'GOOGLE_FORM_IDENTITY_UNVERIFIED',
      });
      // Editing the mapping re-checks the form: refused until it verifies emails again.
      expect(
        await failure(
          svc.bindings.update(
            binding.id,
            { mapping: { schemaVersion: 1, fields: [] } },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'GOOGLE_FORM_EMAIL_NOT_VERIFIED' });
      // Enabling/disabling alone keeps working (the binding is preserved).
      await svc.bindings.update(binding.id, { enabled: false }, admin);
    });
  });

  it('onboarding tasks complete from verified identities only', async () => {
    await scenario(async (tx, fx, svc) => {
      const onboarding = onboardingServices(
        rollbackClient(tx),
        new FixedOnboardingClock(),
      );
      await activeTemplate(onboarding, fx);
      const position = await vacantPosition(tx, fx, { team: true });
      const assignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: position,
          employmentType: 'FULL_TIME',
          status: 'PLANNED',
          startDate: new Date('2026-04-01T00:00:00.000Z'),
          managerAssignmentId: fx.otherTeamA,
        },
      });
      await onboarding.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignment.id },
        ctx(fx.users.onboardingHr!),
      );
      const formId = 'coc-form-1';
      const admin = ctx(fx.users.googleAdmin!);
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(
        formId,
        formInfo(formId, { emailCollection: 'RESPONDER_INPUT' }),
      );
      expect(
        await failure(
          svc.bindings.create(
            {
              organizationId: fx.orgA,
              formId,
              target: 'ONBOARDING_TASKS',
              mapping: MAPPED_EMAIL,
            },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'GOOGLE_FORM_EMAIL_NOT_VERIFIED' });
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'ONBOARDING_TASKS',
          mapping: MAPPED_EMAIL,
        },
        admin,
      );
      const employee1 = await emailOf(tx, fx.selfUser1);
      const task = () =>
        tx.employeeWorkflowTask.findFirstOrThrow({
          where: {
            referenceType: 'GOOGLE_FORM',
            referenceExternalId: formId,
            workflow: { employmentAssignmentId: assignment.id },
          },
        });
      // Spoofed (Employee 1's email typed by someone without a verified email) and mismatched
      // (a verified stranger typing it) come first: had either been trusted, the task would be
      // completed by it. Only the verified response completes it.
      svc.fake.responses.set(formId, [
        formResponse('spoofed', '2026-10-06T08:00:00Z', {
          respondentEmail: null,
          ...typed(employee1),
        }),
        formResponse('mismatched', '2026-10-06T08:01:00Z', {
          respondentEmail: 'stranger@example.com',
          ...typed(employee1),
        }),
        formResponse('verified', '2026-10-06T08:02:00Z', {
          respondentEmail: employee1,
        }),
      ]);
      expect(await svc.sync.syncManually(binding.id, admin)).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 3,
        accepted: 1,
        rejected: 2,
      });
      expect(await task()).toMatchObject({
        status: 'COMPLETED',
        externalCompletionId: 'verified',
      });
    });
  });
});
