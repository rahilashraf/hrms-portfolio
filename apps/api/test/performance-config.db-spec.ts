import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  activeTemplate,
  failure,
  FixedPerformanceClock,
  PERFORMANCE_USERS,
  performanceServices,
  type PerformanceServices,
} from './support/performance-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const LEVELS = [
  { value: 1, label: 'Low', description: null },
  { value: 2, label: 'Medium', description: null },
  { value: 3, label: 'High', description: null },
];

describe('Performance configuration (database)', () => {
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
      svc: PerformanceServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PERFORMANCE_USERS);
          const svc = performanceServices(
            rollbackClient(tx),
            new FixedPerformanceClock(),
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

  it('manages competencies with organization-level permission only', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.templateAdmin!);
      const input = {
        organizationId: fx.orgA,
        code: 'teach',
        name: 'Teaching Quality',
      };
      for (const user of [
        'reader',
        'teamManager',
        'teamTemplate',
        'hr',
        'orgBAdmin',
        'cycleAdmin',
      ]) {
        expect(
          await failure(
            svc.config.createCompetency(input, ctx(fx.users[user]!)),
          ),
        ).toMatchObject({
          status: 403,
        });
      }
      const competency = await svc.config.createCompetency(
        { ...input, category: 'Classroom' },
        admin,
      );
      expect(competency).toMatchObject({
        code: 'TEACH',
        category: 'Classroom',
        archived: false,
      });
      expect(await failure(svc.config.createCompetency(input, admin))).toEqual({
        status: 409,
        code: 'PERFORMANCE_CODE_EXISTS',
      });
      await svc.config.updateCompetency(
        competency.id,
        { name: 'Teaching quality' },
        admin,
      );
      // Any performance permission in the organization reads; HR without it does not.
      expect(
        (await svc.config.competencies(fx.users.teamManager!, fx.orgA)).items,
      ).toHaveLength(1);
      expect(
        await failure(svc.config.competencies(fx.users.hr!, fx.orgA)),
      ).toMatchObject({
        status: 403,
      });
      await svc.config.archiveCompetency(competency.id, admin);
      expect(
        (await svc.config.competencies(fx.users.reader!, fx.orgA)).items,
      ).toEqual([]);
      expect(
        (await svc.config.competencies(fx.users.reader!, fx.orgA, true))
          .items[0],
      ).toMatchObject({ name: 'Teaching quality', archived: true });
      const audit = await tx.auditLog.findMany({
        where: { entityId: competency.id },
      });
      expect(audit.map((row) => row.action).sort()).toEqual([
        'PERFORMANCE_COMPETENCY_ARCHIVED',
        'PERFORMANCE_COMPETENCY_CREATED',
        'PERFORMANCE_COMPETENCY_UPDATED',
      ]);
    });
  });

  it('edits rating scale levels only as a draft', async () => {
    await scenario(async (_tx, fx, svc) => {
      const admin = ctx(fx.users.templateAdmin!);
      expect(
        await failure(
          svc.config.createScale(
            {
              organizationId: fx.orgA,
              code: 'ONE',
              name: 'One',
              levels: [LEVELS[0]!],
            },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_SCALE_LEVELS_INVALID' });
      const scale = await svc.config.createScale(
        {
          organizationId: fx.orgA,
          code: 'three',
          name: 'Three',
          levels: LEVELS,
        },
        admin,
      );
      const edited = await svc.config.updateScale(
        scale.id,
        { levels: [...LEVELS, { value: 4, label: 'Top', description: null }] },
        admin,
      );
      expect(edited.levels.map((l) => l.label)).toEqual([
        'Low',
        'Medium',
        'High',
        'Top',
      ]);
      await svc.config.transitionScale(scale.id, 'ACTIVE', admin);
      expect(
        await failure(
          svc.config.updateScale(scale.id, { levels: LEVELS }, admin),
        ),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_SCALE_ACTIVE',
      });
      // The name can still be clarified; the levels cannot.
      expect(
        (await svc.config.updateScale(scale.id, { name: 'Four point' }, admin))
          .name,
      ).toBe('Four point');
      await svc.config.transitionScale(scale.id, 'ARCHIVED', admin);
      expect(
        await failure(svc.config.transitionScale(scale.id, 'ACTIVE', admin)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_STATUS_INVALID',
      });
    });
  });

  it('validates, activates, freezes and versions templates', async () => {
    await scenario(async (_tx, fx, svc) => {
      const admin = ctx(fx.users.templateAdmin!);
      const scale = await svc.config.createScale(
        { organizationId: fx.orgA, code: 'FIVE', name: 'Five', levels: LEVELS },
        admin,
      );
      const base = {
        organizationId: fx.orgA,
        code: 'teacher-annual',
        name: 'Teacher annual',
        scoringMode: 'WEIGHTED_AVERAGE' as const,
        ratingScaleId: scale.id,
        overallRatingEnabled: true,
        sections: [
          {
            title: 'Teaching',
            items: [
              {
                itemType: 'RATING' as const,
                prompt: 'Planning',
                respondent: 'REVIEWER' as const,
                weight: '50',
              },
              {
                itemType: 'RATING' as const,
                prompt: 'Delivery',
                respondent: 'BOTH' as const,
                weight: '30',
              },
              {
                itemType: 'TEXT' as const,
                prompt: 'Comments',
                respondent: 'BOTH' as const,
              },
            ],
          },
        ],
      };
      // Weights must total 100 over reviewer ratings.
      expect(await failure(svc.config.createTemplate(base, admin))).toEqual({
        status: 400,
        code: 'PERFORMANCE_WEIGHTS_INVALID',
      });
      const fixedSections = [
        {
          title: 'Teaching',
          items: [
            { ...base.sections[0]!.items[0]!, weight: '70' },
            base.sections[0]!.items[1]!,
            base.sections[0]!.items[2]!,
          ],
        },
      ];
      const template = await svc.config.createTemplate(
        { ...base, sections: fixedSections },
        admin,
      );
      expect(template).toMatchObject({
        code: 'TEACHER-ANNUAL',
        status: 'DRAFT',
      });
      expect(template.sections[0]!.items.map((item) => item.weight)).toEqual([
        '70.00',
        '30.00',
        null,
      ]);
      // Activation needs the scale active first.
      expect(
        await failure(
          svc.config.transitionTemplate(template.id, 'ACTIVE', admin),
        ),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_SCALE_NOT_ACTIVE',
      });
      await svc.config.transitionScale(scale.id, 'ACTIVE', admin);
      const active = await svc.config.transitionTemplate(
        template.id,
        'ACTIVE',
        admin,
      );
      expect(active).toMatchObject({
        status: 'ACTIVE',
        actions: { canEdit: false, canCopy: true },
      });
      expect(
        await failure(
          svc.config.updateTemplate(
            template.id,
            { scoringMode: 'NONE', sections: [] },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_TEMPLATE_ACTIVE' });
      // A change is a new draft version.
      const copy = await svc.config.copyTemplate(
        template.id,
        { code: 'teacher-annual-v2' },
        admin,
      );
      expect(copy).toMatchObject({
        code: 'TEACHER-ANNUAL-V2',
        status: 'DRAFT',
        name: 'Teacher annual',
      });
      const unscored = await svc.config.updateTemplate(
        copy.id,
        {
          scoringMode: 'NONE',
          sections: [
            {
              title: 'Comments only',
              items: [
                { itemType: 'TEXT', prompt: 'Notes', respondent: 'REVIEWER' },
              ],
            },
          ],
          overallRatingEnabled: false,
        },
        admin,
      );
      expect(unscored.sections).toHaveLength(1);
      expect(
        (await svc.config.template(fx.users.reader!, template.id)).sections[0]!
          .items,
      ).toHaveLength(3);
      // Other organizations' scales and archived competencies are never used.
      const competency = await svc.config.createCompetency(
        { organizationId: fx.orgA, code: 'OLD', name: 'Old' },
        admin,
      );
      await svc.config.archiveCompetency(competency.id, admin);
      expect(
        await failure(
          svc.config.updateTemplate(
            copy.id,
            {
              scoringMode: 'NONE',
              sections: [
                {
                  title: 'X',
                  items: [
                    {
                      itemType: 'RATING',
                      prompt: 'Old',
                      respondent: 'REVIEWER',
                      ratingScaleId: scale.id,
                      competencyId: competency.id,
                    },
                  ],
                },
              ],
            },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_COMPETENCY_ARCHIVED' });
      const orgBScale = await svc.config.createScale(
        { organizationId: fx.orgB, code: 'ORG-B', name: 'B', levels: LEVELS },
        ctx(fx.users.orgBAdmin!),
      );
      expect(
        await failure(
          svc.config.createTemplate(
            {
              ...base,
              code: 'CROSS',
              scoringMode: 'NONE',
              ratingScaleId: orgBScale.id,
              sections: [],
            },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_SCALE_NOT_FOUND' });
      // The shared fixture template activates too.
      const fixture = await activeTemplate(svc, fx);
      expect(fixture.template.scoringMode).toBe('WEIGHTED_AVERAGE');
    });
  });
});
