import { configureTrustProxy } from './trust-proxy.js';

describe('configureTrustProxy', () => {
  it('configures an explicit numeric proxy-hop count', () => {
    const expressApp = { set: vi.fn() };
    const app = {
      getHttpAdapter: () => ({ getInstance: () => expressApp }),
    };

    configureTrustProxy(app as never, 2);

    expect(expressApp.set).toHaveBeenCalledWith('trust proxy', 2);
  });
});
