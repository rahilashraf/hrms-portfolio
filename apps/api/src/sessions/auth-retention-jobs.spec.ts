import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import {
  assertAuthRetentionConfiguration,
  authRecordRetentionEnabled,
  runPruneAuthRecordsJob,
} from './auth-retention-jobs.js';

/** A client that fails on any use: a disabled run must not touch the database. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('database used while retention is disabled');
    },
  },
) as PrismaService;

describe('sign-in record retention switch', () => {
  it('is off unless explicitly set to true', () => {
    expect(authRecordRetentionEnabled({})).toBe(false);
    expect(
      authRecordRetentionEnabled({ AUTH_RECORD_RETENTION_ENABLED: '' }),
    ).toBe(false);
    expect(
      authRecordRetentionEnabled({ AUTH_RECORD_RETENTION_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      authRecordRetentionEnabled({ AUTH_RECORD_RETENTION_ENABLED: ' TRUE ' }),
    ).toBe(true);
  });

  it('refuses any other value at start-up without echoing it', () => {
    for (const value of ['1', 'yes', 'on', 'secret-value']) {
      let message = '';
      try {
        assertAuthRetentionConfiguration({
          AUTH_RECORD_RETENTION_ENABLED: value,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        'AUTH_RECORD_RETENTION_ENABLED must be "true" or "false".',
      );
      expect(message).not.toContain(value);
    }
    expect(() => assertAuthRetentionConfiguration({})).not.toThrow();
  });

  it('skips the run without touching the database while disabled', async () => {
    for (const env of [{}, { AUTH_RECORD_RETENTION_ENABLED: 'false' }]) {
      await expect(
        runPruneAuthRecordsJob({}, { prisma: untouchable, env }),
      ).resolves.toEqual({
        enabled: false,
        sessionsDeleted: 0,
        tokensDeleted: 0,
        complete: true,
      });
    }
    // No DATABASE_URL is needed either.
    await expect(
      runPruneAuthRecordsJob(undefined, { env: {}, databaseUrl: undefined }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('still refuses parameters and invalid values while disabled', async () => {
    await expect(
      runPruneAuthRecordsJob({ days: 1 }, { prisma: untouchable, env: {} }),
    ).rejects.toThrow('takes no parameters');
    await expect(
      runPruneAuthRecordsJob(
        {},
        { prisma: untouchable, env: { AUTH_RECORD_RETENTION_ENABLED: 'yes' } },
      ),
    ).rejects.toThrow('must be "true" or "false"');
  });
});
