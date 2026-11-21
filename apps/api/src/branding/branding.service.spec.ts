import type { AuditService } from '../audit/audit.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { DEFAULT_PUBLIC_BRANDING, EMPTY_BRANDING } from './branding-domain.js';
import { BrandingService } from './branding.service.js';

const org = (
  name: string,
  branding: Record<string, unknown> | null,
  archivedAt: Date | null = null,
) => ({
  name,
  archivedAt,
  branding: branding ? { ...EMPTY_BRANDING, ...branding } : null,
});

function service(active: unknown[], byCode: unknown = null) {
  const prisma = {
    organization: {
      findUnique: vi.fn().mockResolvedValue(byCode),
      findMany: vi.fn().mockResolvedValue(active),
    },
  };
  return {
    prisma,
    branding: new BrandingService(
      prisma as unknown as PrismaService,
      {} as AuthorizationService,
      {} as AuditService,
    ),
  };
}

describe('BrandingService.publicBranding', () => {
  it('serves the only organization when it opted in (no code needed)', async () => {
    const { branding, prisma } = service([
      org('Solo Inc', { publicLoginEnabled: true, primaryColor: '#123456' }),
    ]);
    await expect(branding.publicBranding(undefined)).resolves.toMatchObject({
      source: 'ORGANIZATION',
      displayName: 'Solo Inc',
      primaryColor: '#123456',
    });
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    // Two rows are enough to decide "exactly one"; only non-archived organizations count.
    expect(prisma.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { archivedAt: null }, take: 2 }),
    );
  });

  it('never serves the only organization when it did not opt in', async () => {
    const { branding } = service([
      org('Solo Inc', { publicLoginEnabled: false }),
    ]);
    await expect(branding.publicBranding(undefined)).resolves.toEqual(
      DEFAULT_PUBLIC_BRANDING,
    );
    const none = service([org('Solo Inc', null)]);
    await expect(none.branding.publicBranding('SOLO')).resolves.toEqual(
      DEFAULT_PUBLIC_BRANDING,
    );
  });

  it('selects only public columns from the database', async () => {
    const { branding, prisma } = service([]);
    await branding.publicBranding('ACME');
    const select = prisma.organization.findUnique.mock.calls[0]![0].select;
    expect(Object.keys(select.branding.select).sort()).toEqual(
      [
        'displayName',
        'shortName',
        'loginLogoUrl',
        'iconUrl',
        'primaryColor',
        'secondaryColor',
        'loginSubtitle',
        'websiteUrl',
        'supportEmail',
        'publicLoginEnabled',
      ].sort(),
    );
    expect(select).not.toHaveProperty('id');
  });
});
