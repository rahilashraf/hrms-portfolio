import { describe, expect, it } from 'vitest';
import {
  dependentsOf,
  effectiveSettingValue,
  featureDisabled,
  isOrganizationModule,
  MODULE_DEFINITIONS,
  moduleChangeProblem,
  ORGANIZATION_MODULES,
  registryProblems,
  SETTING_DEFINITIONS,
  SETTING_KEY_PATTERN,
  settingDefinition,
  settingDisabled,
  settingValueProblem,
  validateSettingValue,
  type FeatureModule,
  type SettingDefinition,
} from './features-domain.js';

const allOn = () => true;
const state =
  (off: readonly FeatureModule[]) =>
  (module: FeatureModule): boolean =>
    !off.includes(module);

describe('features domain — modules', () => {
  it('lists every disableable module and never Core HR', () => {
    expect(ORGANIZATION_MODULES).toEqual([
      'ATTENDANCE',
      'SCHEDULING',
      'LEAVE',
      'COMPENSATION',
      'PAYROLL',
      'BENEFITS',
      'PERFORMANCE',
      'RECRUITMENT',
      'ONBOARDING',
      'DOCUMENTS',
      'NOTIFICATIONS',
      'GOOGLE_WORKSPACE',
      'REPORTING',
    ]);
    for (const core of ['EMPLOYEES', 'ORGANIZATION', 'USERS', 'AUDIT'])
      expect(isOrganizationModule(core)).toBe(false);
    for (const module of ORGANIZATION_MODULES) {
      expect(MODULE_DEFINITIONS[module].module).toBe(module);
      expect(MODULE_DEFINITIONS[module].name.length).toBeGreaterThan(0);
    }
  });

  it('declares only the dependencies that exist in the code', () => {
    const edges = ORGANIZATION_MODULES.flatMap((module) =>
      MODULE_DEFINITIONS[module].requires.map((r) => `${module}->${r}`),
    );
    expect(edges.sort()).toEqual([
      'PAYROLL->ATTENDANCE',
      'PAYROLL->COMPENSATION',
    ]);
    expect(dependentsOf('COMPENSATION')).toEqual(['PAYROLL']);
    expect(dependentsOf('ATTENDANCE')).toEqual(['PAYROLL']);
    expect(dependentsOf('PAYROLL')).toEqual([]);
    expect(dependentsOf('BENEFITS')).toEqual([]);
  });

  it('has an acyclic dependency graph whose edges point at modules', () => {
    const visiting = new Set<FeatureModule>();
    const done = new Set<FeatureModule>();
    const visit = (module: FeatureModule) => {
      expect(visiting.has(module)).toBe(false);
      if (done.has(module)) return;
      visiting.add(module);
      for (const required of MODULE_DEFINITIONS[module].requires) {
        expect(isOrganizationModule(required)).toBe(true);
        expect(required).not.toBe(module);
        visit(required);
      }
      visiting.delete(module);
      done.add(module);
    };
    for (const module of ORGANIZATION_MODULES) visit(module);
  });

  it('refuses disabling a module others depend on, listing the enabled dependents', () => {
    expect(moduleChangeProblem('COMPENSATION', false, allOn)).toEqual({
      code: 'FEATURE_DEPENDENTS_ENABLED',
      modules: ['PAYROLL'],
    });
    expect(moduleChangeProblem('ATTENDANCE', false, allOn)).toEqual({
      code: 'FEATURE_DEPENDENTS_ENABLED',
      modules: ['PAYROLL'],
    });
    // Once the dependent is off, the dependency may be disabled.
    expect(
      moduleChangeProblem('COMPENSATION', false, state(['PAYROLL'])),
    ).toBeNull();
    expect(moduleChangeProblem('PERFORMANCE', false, allOn)).toBeNull();
  });

  it('refuses enabling a module whose requirements are disabled', () => {
    expect(
      moduleChangeProblem(
        'PAYROLL',
        true,
        state(['COMPENSATION', 'ATTENDANCE']),
      ),
    ).toEqual({
      code: 'FEATURE_DEPENDENCY_DISABLED',
      modules: ['COMPENSATION', 'ATTENDANCE'],
    });
    expect(moduleChangeProblem('PAYROLL', true, state(['ATTENDANCE']))).toEqual(
      {
        code: 'FEATURE_DEPENDENCY_DISABLED',
        modules: ['ATTENDANCE'],
      },
    );
    expect(moduleChangeProblem('PAYROLL', true, allOn)).toBeNull();
    expect(moduleChangeProblem('LEAVE', true, state(['PAYROLL']))).toBeNull();
  });

  it('builds the FEATURE_DISABLED and SETTING_DISABLED 403 shapes', () => {
    const error = featureDisabled('PAYROLL');
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({
      statusCode: 403,
      code: 'FEATURE_DISABLED',
      module: 'PAYROLL',
    });
    const setting = settingDisabled('documents.selfServiceProvide');
    expect(setting.getStatus()).toBe(403);
    expect(setting.getResponse()).toMatchObject({
      code: 'SETTING_DISABLED',
      key: 'documents.selfServiceProvide',
    });
  });
});

describe('features domain — settings registry', () => {
  it('is consistent: unique well-formed keys, known modules, valid defaults', () => {
    expect(registryProblems()).toEqual([]);
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.key).toMatch(SETTING_KEY_PATTERN);
      expect(definition.schemaVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('only registers settings of behaviour that exists, defaulting to the current behaviour', () => {
    expect(
      SETTING_DEFINITIONS.map((d) => [d.key, d.module, d.default]),
    ).toEqual([
      ['documents.selfServiceProvide', 'DOCUMENTS', true],
      ['onboarding.employeeTaskCompletion', 'ONBOARDING', true],
      ['performance.selfReview', 'PERFORMANCE', true],
      // Security remediation M2: on for every organization unless a SYSTEM administrator
      // turns it off (with a reason).
      ['payroll.dualControl', 'PAYROLL', true],
      ['recruitment.externalIntake', 'RECRUITMENT', true],
      ['google.sync.performanceEvidence', 'GOOGLE_WORKSPACE', true],
      ['google.sync.recruitmentIntake', 'GOOGLE_WORKSPACE', true],
      ['google.sync.onboardingTasks', 'GOOGLE_WORKSPACE', true],
      ['google.drive.verify', 'GOOGLE_WORKSPACE', true],
      // Phase 19 retention periods: off (0) unless an organization opts in.
      ['retention.rejectedCandidateMonths', 'RECRUITMENT', 0],
      ['retention.notificationMonths', 'NOTIFICATIONS', 0],
      ['retention.deliveryLogMonths', 'NOTIFICATIONS', 0],
      ['retention.syncLogMonths', 'GOOGLE_WORKSPACE', 0],
      ['retention.auditLogMonths', 'CORE', 0],
    ]);
    // Time & attendance and notification settings keep their own homes (no second source).
    expect(SETTING_DEFINITIONS.some((d) => d.key.startsWith('time.'))).toBe(
      false,
    );
    expect(
      SETTING_DEFINITIONS.some((d) => d.key.startsWith('notifications.')),
    ).toBe(false);
  });

  it('detects malformed registries', () => {
    const base: SettingDefinition = {
      key: 'x.flag',
      module: 'DOCUMENTS',
      type: { kind: 'boolean' },
      default: true,
      schemaVersion: 1,
      name: 'x',
      description: 'x',
    };
    expect(registryProblems([base, base])).toContain('x.flag: duplicate');
    expect(registryProblems([{ ...base, key: 'Bad Key' }])).toContain(
      'Bad Key: malformed key',
    );
    expect(registryProblems([{ ...base, key: 'flag' }])).toContain(
      'flag: malformed key',
    );
    expect(registryProblems([{ ...base, default: 'yes' }])).toContain(
      'x.flag: invalid default',
    );
    expect(
      registryProblems([
        { ...base, type: { kind: 'integer', min: 5, max: 1 }, default: 3 },
      ]),
    ).toContain('x.flag: invalid bounds');
    expect(
      registryProblems([
        { ...base, type: { kind: 'enum', values: ['A', 'A'] }, default: 'A' },
      ]),
    ).toContain('x.flag: invalid values');
    expect(registryProblems([{ ...base, schemaVersion: 0 }])).toContain(
      'x.flag: invalid schemaVersion',
    );
    // CORE is the section of core-HR settings (Phase 19 audit retention); nothing else is.
    expect(
      registryProblems([
        { ...base, module: 'AUDIT' as unknown as FeatureModule },
      ]),
    ).toContain('x.flag: unknown module');
    expect(registryProblems([{ ...base, module: 'CORE' }])).toEqual([]);
    expect(
      registryProblems([
        {
          ...base,
          type: { kind: 'integer', min: 1, max: 10, minWhenEnabled: 3 },
          default: 3,
        },
      ]),
    ).toContain('x.flag: invalid minWhenEnabled');
  });

  it('validates values strictly against their type (no coercion)', () => {
    const bool = { kind: 'boolean' } as const;
    expect(settingValueProblem(bool, true)).toBeNull();
    expect(settingValueProblem(bool, false)).toBeNull();
    for (const value of ['true', 1, 0, null, undefined, {}, []])
      expect(settingValueProblem(bool, value)).toBe('must be a boolean');

    const int = { kind: 'integer', min: 1, max: 30 } as const;
    expect(settingValueProblem(int, 1)).toBeNull();
    expect(settingValueProblem(int, 30)).toBeNull();
    expect(settingValueProblem(int, 0)).toBe('must be from 1 to 30');
    expect(settingValueProblem(int, 31)).toBe('must be from 1 to 30');
    expect(settingValueProblem(int, 2.5)).toBe('must be an integer');
    expect(settingValueProblem(int, '5')).toBe('must be an integer');
    expect(settingValueProblem(int, Number.NaN)).toBe('must be an integer');

    const choice = { kind: 'enum', values: ['A', 'B'] } as const;
    expect(settingValueProblem(choice, 'A')).toBeNull();
    expect(settingValueProblem(choice, 'a')).toBe('must be one of A, B');
    expect(settingValueProblem(choice, 1)).toBe('must be one of A, B');
  });

  it('rejects invalid writes with SETTING_VALUE_INVALID (400)', () => {
    const definition = settingDefinition('documents.selfServiceProvide')!;
    expect(validateSettingValue(definition, false)).toBe(false);
    let thrown: unknown;
    try {
      validateSettingValue(definition, 'false');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const response = thrown as { getResponse(): unknown; getStatus(): number };
    expect(response.getStatus()).toBe(400);
    expect(response.getResponse()).toMatchObject({
      code: 'SETTING_VALUE_INVALID',
      key: 'documents.selfServiceProvide',
    });
  });

  it('knows unknown keys', () => {
    expect(settingDefinition('documents.unknown')).toBeUndefined();
    expect(settingDefinition('time.selfClock')).toBeUndefined();
  });

  it('falls back to the default without a row, after a reset, or for stale values', () => {
    const definition = settingDefinition('google.drive.verify')!;
    expect(effectiveSettingValue(definition, null)).toEqual({
      value: true,
      isDefault: true,
    });
    expect(
      effectiveSettingValue(definition, { value: null, schemaVersion: 1 }),
    ).toEqual({ value: true, isDefault: true });
    expect(
      effectiveSettingValue(definition, { value: false, schemaVersion: 1 }),
    ).toEqual({ value: false, isDefault: false });
    // Another schema version or a value that no longer fits is never trusted.
    expect(
      effectiveSettingValue(definition, { value: false, schemaVersion: 2 }),
    ).toEqual({ value: true, isDefault: true });
    expect(
      effectiveSettingValue(definition, { value: 'no', schemaVersion: 1 }),
    ).toEqual({ value: true, isDefault: true });
  });
});
