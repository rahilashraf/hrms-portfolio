import { PERMISSION_CATALOG } from './authorization-catalog.js';
import {
  PERMISSION_AREAS,
  PERMISSION_METADATA,
  permissionMetadata,
} from './permission-metadata.js';

describe('permission metadata', () => {
  it('gives every catalog permission an area and a label, and nothing else', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(Object.keys(PERMISSION_METADATA).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const metadata = PERMISSION_METADATA[key];
      expect(PERMISSION_AREAS, key).toContain(metadata.area);
      expect(metadata.label.trim(), key).not.toBe('');
      expect(metadata.label.length, key).toBeLessThanOrEqual(40);
    }
  });

  it('uses unique labels within an area', () => {
    const seen = new Set<string>();
    for (const { area, label } of Object.values(PERMISSION_METADATA)) {
      expect(seen.has(`${area}:${label}`), label).toBe(false);
      seen.add(`${area}:${label}`);
    }
  });

  it('catalogs the Phase 20 branding permission', () => {
    const branding = PERMISSION_CATALOG.find(
      ({ key }) => key === 'organization.branding.manage',
    );
    expect(branding?.description).toMatch(/organization scope/);
    expect(permissionMetadata('organization.branding.manage')).toEqual({
      area: 'Administration',
      label: 'Manage branding',
    });
  });

  it('falls back for keys outside the catalog', () => {
    expect(permissionMetadata('retired.key')).toEqual({
      area: 'Administration',
      label: 'retired.key',
    });
  });
});
