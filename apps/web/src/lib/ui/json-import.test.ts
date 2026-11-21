import { describe, expect, it } from 'vitest';
import { parseJsonArray } from './json-import';

describe('parseJsonArray', () => {
  it('accepts a JSON array', () => {
    expect(parseJsonArray('[{"id":1}, 2]')).toEqual({ ok: true, items: [{ id: 1 }, 2] });
    expect(parseJsonArray('[]')).toEqual({ ok: true, items: [] });
  });

  it('refuses invalid JSON and non-arrays with a message instead of an empty list', () => {
    expect(parseJsonArray('')).toMatchObject({ ok: false, message: /not valid JSON/ });
    expect(parseJsonArray('[{"id": 1},')).toMatchObject({ ok: false, message: /not valid JSON/ });
    expect(parseJsonArray('{"id": 1}')).toMatchObject({ ok: false, message: /JSON array/ });
    expect(parseJsonArray('42')).toMatchObject({ ok: false, message: /JSON array/ });
  });
});
