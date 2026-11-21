import { moduleLabel } from './errors';
import type { SettingType } from './types';

/** The heading of the CORE settings section (settings that tune no optional module). */
export const CORE_SECTION_LABEL = 'Core HR & audit';

/** The heading of a settings section: a module's name, or the core HR section. */
export function settingSectionLabel(section: string): string {
  return section === 'CORE' ? CORE_SECTION_LABEL : moduleLabel(section);
}

export const RETENTION_HELP = '0 = keep forever (retention off)';

/** Retention periods (`retention.*`): 0 keeps the data forever. */
export function isRetentionSetting(key: string): boolean {
  return key.startsWith('retention.');
}

type IntegerType = Extract<SettingType, { kind: 'integer' }>;

/** The floor of an integer setting that may also be 0 (off), or null when every value counts. */
function offFloor(type: IntegerType): number | null {
  return type.minWhenEnabled !== undefined && type.min <= 0 && type.minWhenEnabled > 0
    ? type.minWhenEnabled
    : null;
}

/** The accepted values of an integer setting, for the hint under the input. */
export function integerRangeText(type: IntegerType): string {
  const floor = offFloor(type);
  return floor === null ? `${type.min}–${type.max}` : `0 (off) or ${floor}–${type.max}`;
}

/**
 * Parses the draft of an integer setting. Mirrors the API rule (features-domain
 * settingValueProblem): a whole number from min to max and, with `minWhenEnabled`, either 0
 * (off) or at least `minWhenEnabled`. The API re-checks every value.
 */
export function parseIntegerSetting(
  type: IntegerType,
  draft: string,
): { value: number; problem: null } | { value: null; problem: string } {
  const number = Number(draft);
  if (draft.trim() === '' || !Number.isInteger(number)) {
    return { value: null, problem: 'Enter a whole number.' };
  }
  const floor = offFloor(type);
  if (floor !== null) {
    if (number === 0 || (number >= floor && number <= type.max)) {
      return { value: number, problem: null };
    }
    return {
      value: null,
      problem: `Enter 0 to turn this off, or a number from ${floor} to ${type.max}.`,
    };
  }
  if (number < type.min || number > type.max) {
    return { value: null, problem: `Enter a number from ${type.min} to ${type.max}.` };
  }
  return { value: number, problem: null };
}
