import { DEVELOPMENT_PORT, resolveListenPort } from './listen-port.js';

describe('resolveListenPort', () => {
  it('uses the platform PORT', () => {
    expect(resolveListenPort('8080', true)).toBe(8080);
    expect(resolveListenPort('4000', false)).toBe(4000);
  });

  it('falls back to 3001 only outside production', () => {
    expect(resolveListenPort(undefined, false)).toBe(DEVELOPMENT_PORT);
    expect(resolveListenPort('', false)).toBe(DEVELOPMENT_PORT);
    expect(() => resolveListenPort(undefined, true)).toThrow(/PORT/);
    expect(() => resolveListenPort(' ', true)).toThrow(/PORT/);
  });

  it('rejects an invalid port', () => {
    for (const raw of ['0', '65536', '3001.5', 'http', '-1']) {
      expect(() => resolveListenPort(raw, false)).toThrow(/PORT/);
    }
  });
});
