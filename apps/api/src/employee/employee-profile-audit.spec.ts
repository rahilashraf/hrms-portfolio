import { describe, expect, it } from 'vitest';
import {
  maskEmail,
  maskName,
  maskPhone,
  profileAuditChanges,
} from './employee-profile-audit.js';

const person = {
  firstName: 'Ada',
  middleName: 'Augusta',
  lastName: 'Lovelace',
  preferredName: 'Ada',
  personalEmail: 'ada.lovelace@example.com',
  phone: '+1 (416) 555-0134',
};

describe('profile audit representation (R4-A.2)', () => {
  it('masks names and contact details, keeping only a hint', () => {
    expect(maskName('Augusta')).toBe('A***');
    expect(maskName('  Émilie')).toBe('É***');
    expect(maskName('   ')).toBe('***');
    expect(maskEmail('ada.lovelace@example.com')).toBe('a***@***.com');
    // A personal domain can identify someone: only its top-level domain is kept.
    expect(maskEmail('ada@lovelace.example')).toBe('a***@***.example');
    expect(maskEmail('ada@localhost')).toBe('a***@***');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('ada@')).toBe('***');
    expect(maskPhone('+1 (416) 555-0134')).toBe('***34');
    expect(maskPhone('123')).toBe('***');
  });

  it('records only changed fields, every value masked', () => {
    const result = profileAuditChanges(person, {
      firstName: 'Augusta',
      lastName: 'Lovelace', // same value: not a change
      personalEmail: 'ada@newmail.example',
      phone: null,
    });
    expect(result).toEqual({
      changed: ['firstName', 'personalEmail', 'phone'],
      cleared: ['phone'],
      changes: {
        firstName: { before: 'A***', after: 'A***' },
        personalEmail: { before: 'a***@***.com', after: 'a***@***.example' },
        phone: { before: '***34', after: null },
      },
      masked: ['firstName', 'personalEmail', 'phone'],
    });
    // No full name or contact value appears anywhere in the entry.
    const text = JSON.stringify(result);
    expect(text).not.toContain('Augusta');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('newmail');
    expect(text).not.toContain('lovelace@');
    expect(text).not.toContain('ada@newmail');
    expect(text).not.toContain('555-0134');
  });

  it('distinguishes omitted (unchanged) from null (cleared), and setting a field that was empty', () => {
    expect(profileAuditChanges(person, {})).toEqual({
      changed: [],
      cleared: [],
      changes: {},
      masked: [],
    });
    const result = profileAuditChanges(
      { ...person, middleName: null },
      { middleName: 'Byron', preferredName: null },
    );
    expect(result.changes).toEqual({
      middleName: { before: null, after: 'B***' },
      preferredName: { before: 'A***', after: null },
    });
    expect(result.cleared).toEqual(['preferredName']);
    // Clearing an already-empty field is not a change.
    expect(
      profileAuditChanges({ ...person, middleName: null }, { middleName: null })
        .changed,
    ).toEqual([]);
  });

  it('ignores anything that is not a profile field', () => {
    const result = profileAuditChanges(person, {
      firstName: 'Ada',
      ...({ password: 'secret', email: 'x@example.com' } as object),
    });
    expect(result.changed).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/secret|x@example/);
  });
});
