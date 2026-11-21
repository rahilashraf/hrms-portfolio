import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const user = {
    id: 'user-1',
    personId: 'person-1',
    email: 'person@example.com',
    passwordHash: 'argon-hash',
    status: 'ACTIVE',
    archivedAt: null,
    mustChangePassword: true,
    emailVerifiedAt: null,
  };
  function createService(overrides: Record<string, unknown> = {}) {
    const createSession = vi.fn().mockResolvedValue({ id: 'session-1' });
    const updateSession = vi.fn().mockResolvedValue({ count: 1 });
    const resetUserLoginState = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (callback) =>
        callback({
          authSession: {
            create: createSession,
            updateMany: updateSession,
          },
          user: {
            update: vi.fn(),
            updateMany: resetUserLoginState,
          },
          accountToken: {
            create: vi.fn().mockResolvedValue({ id: 'token-1' }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          auditLog: { create: vi.fn(), createMany: vi.fn() },
        }),
      ),
      ...overrides,
    };
    const audit = { write: vi.fn() };
    const users = {
      findForLogin: vi.fn().mockResolvedValue(user),
      findIdentity: vi.fn(),
      recordFailedLogin: vi.fn(),
      findForAccountRecovery: vi.fn(),
      findById: vi.fn(),
    };
    const sessions = {
      generateRefreshToken: vi.fn().mockReturnValue('opaque-refresh-token'),
      hashRefreshToken: vi.fn((token: string) =>
        token === 'opaque-refresh-token'
          ? 'stored-hash-only'
          : `sha256:${token}`,
      ),
      findRefreshSession: vi.fn(),
    };
    const passwords = {
      verifyPassword: vi.fn().mockResolvedValue(true),
      verifyDummyPassword: vi.fn(),
      hashPassword: vi.fn().mockResolvedValue('argon2-new-hash'),
    };
    const accessTokens = {
      issue: vi.fn().mockResolvedValue('signed-access-token'),
    };
    const accountTokens = {
      issue: vi.fn().mockResolvedValue({
        token: 'opaque-account-token',
        expiresAt: new Date(Date.now() + 1000),
      }),
      findUsable: vi.fn(),
      consume: vi.fn().mockResolvedValue({ count: 1 }),
      invalidateOutstanding: vi.fn(),
    };
    const emails = {
      assertAvailable: vi.fn(),
      sendPasswordReset: vi.fn(),
      sendInvitation: vi.fn(),
      sendVerification: vi.fn(),
    };
    const rateLimiter = {
      assertLoginAllowed: vi.fn(),
      assertVerificationResendAllowed: vi.fn(),
    };
    const recovery = { enqueue: vi.fn() };
    const service = new AuthService(
      prisma as never,
      audit as never,
      users as never,
      sessions as never,
      passwords as never,
      accessTokens as never,
      accountTokens as never,
      emails as never,
      rateLimiter as never,
      recovery as never,
    );
    return {
      recovery,
      service,
      prisma,
      audit,
      users,
      sessions,
      passwords,
      accessTokens,
      accountTokens,
      emails,
      rateLimiter,
      createSession,
      updateSession,
      resetUserLoginState,
    };
  }

  it('authenticates an active account and persists only the refresh hash', async () => {
    vi.setSystemTime(now);
    const {
      service,
      prisma,
      audit,
      sessions,
      accessTokens,
      createSession,
      resetUserLoginState,
    } = createService();
    const result = await service.login(' PERSON@example.com ', 'password', {});

    expect(sessions.hashRefreshToken).toHaveBeenCalledWith(
      'opaque-refresh-token',
    );
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(resetUserLoginState).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: user.id,
          status: 'ACTIVE',
          archivedAt: null,
        }),
        data: expect.objectContaining({
          failedLoginAttempts: 0,
          lockedUntil: null,
        }),
      }),
    );
    expect(audit.write).toHaveBeenCalledTimes(2);
    const createdSessionData = createSession.mock.calls[0]![0].data;
    expect(createdSessionData.refreshTokenHash).toBe('stored-hash-only');
    expect(createdSessionData).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(createdSessionData)).not.toContain(
      'opaque-refresh-token',
    );
    expect(result).toMatchObject({
      accessToken: 'signed-access-token',
      refreshToken: 'opaque-refresh-token',
      identity: { mustChangePassword: true },
    });
    expect(accessTokens.issue).toHaveBeenCalledWith({
      userId: user.id,
      sessionId: 'session-1',
    });
    vi.useRealTimers();
  });

  it.each([
    ['unknown email', null],
    ['inactive account', { ...user, status: 'DISABLED' }],
    ['archived account', { ...user, archivedAt: now }],
    ['missing password', { ...user, passwordHash: null }],
  ])('rejects %s with generic credentials error', async (_case, loginUser) => {
    const { service, users, passwords } = createService();
    users.findForLogin.mockResolvedValue(loginUser);

    await expect(
      service.login('person@example.com', 'wrong', {}),
    ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
    if (!loginUser || loginUser.passwordHash === null) {
      expect(passwords.verifyDummyPassword).toHaveBeenCalledWith('wrong');
    }
  });

  it('records invalid attempts only for eligible accounts and audits lockout', async () => {
    const { service, users, passwords, audit, rateLimiter } = createService();
    users.recordFailedLogin.mockResolvedValue({
      failedLoginAttempts: 5,
      lockedUntil: new Date(Date.now() + 15 * 60_000),
    });
    passwords.verifyPassword.mockResolvedValue(false);

    await expect(
      service.login(user.email, 'wrong', { ipAddress: '192.0.2.1' }),
    ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));

    expect(rateLimiter.assertLoginAllowed).toHaveBeenCalledWith(
      '192.0.2.1',
      user.email,
    );
    expect(users.recordFailedLogin).toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGIN_FAILED',
        entityId: user.id,
        metadata: { reasonCode: 'INVALID_PASSWORD' },
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_ACCOUNT_TEMP_LOCKED' }),
    );
    // Never the address or the password that was typed.
    expect(JSON.stringify(audit.write.mock.calls)).not.toContain('wrong');
  });

  it('audits failed sign-ins of locked and inactive accounts with their reason code', async () => {
    const locked = createService();
    locked.users.findForLogin.mockResolvedValue({
      ...user,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    await expect(
      locked.service.login(user.email, 'whatever', {}),
    ).rejects.toThrow(UnauthorizedException);
    expect(locked.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGIN_FAILED',
        metadata: { reasonCode: 'LOCKED' },
      }),
    );
    expect(locked.users.recordFailedLogin).not.toHaveBeenCalled();

    const disabled = createService();
    disabled.users.findForLogin.mockResolvedValue({
      ...user,
      status: 'DISABLED',
    });
    await expect(
      disabled.service.login(user.email, 'whatever', {}),
    ).rejects.toThrow(UnauthorizedException);
    expect(disabled.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGIN_FAILED',
        metadata: { reasonCode: 'INACTIVE' },
      }),
    );
  });

  it('does not write account state for unknown or ineligible login attempts', async () => {
    const { service, users, audit } = createService();
    users.findForLogin.mockResolvedValue(null);

    await expect(
      service.login('missing@example.com', 'wrong', {}),
    ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));

    expect(users.recordFailedLogin).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('rotates the current refresh token and returns a replacement', async () => {
    const { service, sessions, accessTokens, updateSession, audit } =
      createService();
    const activeSession = {
      id: 'session-1',
      userId: user.id,
      refreshTokenHash: 'sha256:current',
      previousRefreshTokenHash: null,
      previousTokenValidUntil: null,
      expiresAt: new Date('2030-02-01T00:00:00.000Z'),
      revokedAt: null,
      user: { ...user },
    };
    sessions.findRefreshSession.mockResolvedValue(activeSession);

    const result = await service.refresh('current', {});

    expect(result).toEqual({
      accessToken: 'signed-access-token',
      refreshToken: 'opaque-refresh-token',
    });
    expect(sessions.hashRefreshToken).toHaveBeenCalledWith(
      'opaque-refresh-token',
    );
    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          refreshTokenHash: 'sha256:current',
        }),
        data: expect.objectContaining({
          refreshTokenHash: 'stored-hash-only',
          previousRefreshTokenHash: 'sha256:current',
        }),
      }),
    );
    expect(JSON.stringify(updateSession.mock.calls[0]![0])).not.toContain(
      'opaque-refresh-token',
    );
    expect(accessTokens.issue).toHaveBeenCalledWith({
      userId: user.id,
      sessionId: 'session-1',
    });
    // D2: a routine rotation leaves no audit entry (the session's lastUsedAt records it).
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('allows the previous token only within the grace period without rotating', async () => {
    const { service, prisma, sessions } = createService();
    sessions.findRefreshSession.mockResolvedValue({
      id: 'session-1',
      userId: user.id,
      refreshTokenHash: 'sha256:current',
      previousRefreshTokenHash: 'sha256:previous',
      previousTokenValidUntil: new Date(Date.now() + 10_000),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { ...user },
    });

    const result = await service.refresh('previous', {});

    expect(result).toEqual({ accessToken: 'signed-access-token' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('handles a concurrent current-token rotation without replacing its cookie', async () => {
    const { service, prisma, sessions, accessTokens } = createService();
    const currentSession = {
      id: 'session-1',
      userId: user.id,
      refreshTokenHash: 'sha256:current',
      previousRefreshTokenHash: null,
      previousTokenValidUntil: null,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { ...user },
    };
    sessions.findRefreshSession
      .mockResolvedValueOnce(currentSession)
      .mockResolvedValueOnce({
        ...currentSession,
        refreshTokenHash: 'sha256:new-current',
        previousRefreshTokenHash: 'sha256:current',
        previousTokenValidUntil: new Date(Date.now() + 10_000),
      });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        authSession: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        auditLog: { create: vi.fn() },
      }),
    );

    const result = await service.refresh('current', {});

    expect(result).toEqual({ accessToken: 'signed-access-token' });
    expect(result).not.toHaveProperty('refreshToken');
    expect(accessTokens.issue).toHaveBeenCalledWith({
      userId: user.id,
      sessionId: 'session-1',
    });
  });

  it('revokes and rejects a previous token outside grace', async () => {
    const { service, prisma, sessions, audit } = createService();
    const transactionUpdate = vi.fn().mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        authSession: { updateMany: transactionUpdate },
        auditLog: { create: vi.fn() },
      }),
    );
    const tokenHash = 'sha256:previous';
    const sessionLookup = {
      id: 'session-1',
      userId: user.id,
      refreshTokenHash: 'sha256:current',
      previousRefreshTokenHash: tokenHash,
      previousTokenValidUntil: new Date(Date.now() - 1),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { ...user },
    };
    sessions.findRefreshSession.mockResolvedValue(sessionLookup);

    await expect(service.refresh('previous', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          previousRefreshTokenHash: tokenHash,
        }),
      }),
    );
    expect(audit.write).toHaveBeenCalledTimes(2);
  });

  it('rejects missing refresh tokens', async () => {
    const { service } = createService();

    await expect(service.refresh(undefined, {})).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1), revokedAt: null }],
    [
      'revoked',
      {
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
    ],
  ])('rejects a %s refresh session', async (_state, fields) => {
    const { service, sessions, prisma } = createService();
    sessions.findRefreshSession.mockResolvedValue({
      id: 'session-1',
      userId: user.id,
      refreshTokenHash: 'sha256:current',
      previousRefreshTokenHash: null,
      previousTokenValidUntil: null,
      user: { ...user },
      ...fields,
    });

    await expect(service.refresh('current', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown refresh tokens without trying to revoke a session', async () => {
    const { service, sessions, prisma } = createService();
    sessions.findRefreshSession.mockResolvedValue(null);

    await expect(service.refresh('unknown', {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('revokes a session on logout and audits the revocation', async () => {
    const { service, sessions, prisma, audit } = createService();
    sessions.findRefreshSession.mockResolvedValue({
      id: 'session-1',
      userId: user.id,
    });

    await service.logout('current', {});

    expect(sessions.hashRefreshToken).toHaveBeenCalledWith('current');
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledTimes(2);
  });

  it('revokes all active sessions and writes a summary audit event', async () => {
    const { service, prisma, audit } = createService();

    await service.logoutAll(user.id, {});

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGOUT_ALL',
        metadata: { revokedSessionCount: 1 },
      }),
      expect.any(Object),
    );
  });

  it.each([
    ['existing eligible user', { ...user }],
    ['unknown user', null],
  ])(
    'returns a generic forgot-password response for %s',
    async (_case, target) => {
      const { service, users, accountTokens, emails, recovery } =
        createService();
      users.findForAccountRecovery.mockResolvedValue(target);

      const result = await service.forgotPassword(' PERSON@example.com ');

      expect(result.message).toContain('If the account is eligible');
      // D6: exactly one queued job either way; nothing issued or sent in the API.
      expect(recovery.enqueue).toHaveBeenCalledTimes(1);
      expect(recovery.enqueue).toHaveBeenCalledWith({
        kind: 'password-reset',
        userId: target ? user.id : null,
        requestedAt: expect.any(String),
      });
      expect(JSON.stringify(recovery.enqueue.mock.calls)).not.toContain(
        'example.com',
      );
      expect(accountTokens.issue).not.toHaveBeenCalled();
      expect(emails.sendPasswordReset).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['existing eligible account', { ...user }],
    ['nonexistent account', null],
  ])(
    'returns the same provider-unavailable response for forgot-password with a %s',
    async (_case, target) => {
      const { service, users, emails } = createService();
      users.findForAccountRecovery.mockResolvedValue(target);
      emails.assertAvailable.mockImplementation(() => {
        throw new ServiceUnavailableException(
          'Transactional email provider is not configured',
        );
      });

      const request = service.forgotPassword('person@example.com');

      await expect(request).rejects.toMatchObject({
        status: 503,
        response: {
          statusCode: 503,
          message: 'Transactional email provider is not configured',
        },
      });
      expect(users.findForAccountRecovery).not.toHaveBeenCalled();
      expect(emails.assertAvailable).toHaveBeenCalledTimes(1);
    },
  );

  it('resets password, consumes reset tokens, clears lockout, and revokes sessions', async () => {
    const { service, accountTokens, passwords, audit } = createService();
    accountTokens.findUsable.mockResolvedValue({
      id: 'token-id',
      userId: user.id,
      user: { ...user },
    });

    await expect(
      service.resetPassword('raw-reset-token', 'a secure passphrase', {}),
    ).resolves.toEqual({ success: true });

    expect(passwords.hashPassword).toHaveBeenCalledWith('a secure passphrase');
    expect(accountTokens.consume).toHaveBeenCalled();
    expect(accountTokens.invalidateOutstanding).toHaveBeenCalledWith(
      expect.any(Object),
      user.id,
      'PASSWORD_RESET',
      expect.any(Date),
    );
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_PASSWORD_RESET_COMPLETED',
      }),
      expect.any(Object),
    );
    const transaction = (
      accountTokens.consume.mock.calls[0] as unknown[]
    )[0] as {
      user: { updateMany: ReturnType<typeof vi.fn> };
    };
    expect(transaction.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failedLoginAttempts: 0,
          lockedUntil: null,
        }),
      }),
    );
  });

  it('rejects reset passwords outside the shared policy', async () => {
    const { service, passwords } = createService();
    await expect(service.resetPassword('token', 'short', {})).rejects.toThrow();
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });

  it('accepts an invitation and activates an invited passwordless user', async () => {
    const { service, accountTokens, passwords, audit } = createService();
    accountTokens.findUsable.mockResolvedValue({
      id: 'invitation-id',
      userId: 'invited-user',
      user: {
        ...user,
        id: 'invited-user',
        status: 'INVITED',
        passwordHash: null,
      },
    });

    await expect(
      service.acceptInvitation('raw-invite-token', 'a secure passphrase', {}),
    ).resolves.toEqual({ success: true });
    expect(passwords.hashPassword).toHaveBeenCalledWith('a secure passphrase');
    expect(accountTokens.consume).toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_INVITATION_ACCEPTED' }),
      expect.any(Object),
    );
  });

  it('issues invitations only for pre-existing invited passwordless users', async () => {
    const { service, users, accountTokens, emails } = createService();
    users.findById.mockResolvedValue({
      ...user,
      status: 'INVITED',
      passwordHash: null,
    });

    await service.issueInvitation('invited-user');

    expect(accountTokens.issue).toHaveBeenCalledWith(
      user.id,
      'INVITATION',
      7 * 24 * 60 * 60_000,
      expect.objectContaining({ action: 'AUTH_INVITATION_CREATED' }),
    );
    expect(emails.sendInvitation).toHaveBeenCalled();

    users.findById.mockResolvedValue(user);
    await expect(service.issueInvitation(user.id)).rejects.toThrow();
    expect(accountTokens.issue).toHaveBeenCalledTimes(1);
  });

  it('does not issue invitations for active, archived, or passworded accounts', async () => {
    const { service, users, accountTokens, emails } = createService();
    users.findById.mockResolvedValue({
      ...user,
      status: 'INVITED',
      passwordHash: 'already-set',
    });

    await expect(service.issueInvitation(user.id)).rejects.toThrow();

    expect(accountTokens.issue).not.toHaveBeenCalled();
    expect(emails.sendInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', null],
    ['used', null],
  ])('rejects an %s invitation token', async (_case, tokenRecord) => {
    const { service, accountTokens, passwords } = createService();
    accountTokens.findUsable.mockResolvedValue(tokenRecord);

    await expect(
      service.acceptInvitation('invalid-token', 'a secure passphrase', {}),
    ).rejects.toThrow(UnauthorizedException);
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });

  it('verifies email and records an audit event', async () => {
    const { service, accountTokens, audit } = createService();
    accountTokens.findUsable.mockResolvedValue({
      id: 'verification-id',
      userId: user.id,
      user: { ...user, emailVerifiedAt: null },
    });

    await expect(
      service.verifyEmail('raw-verification-token', {}),
    ).resolves.toEqual({ success: true });
    expect(accountTokens.consume).toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_EMAIL_VERIFIED' }),
      expect.any(Object),
    );
  });

  it('rejects invalid or previously used email verification tokens', async () => {
    const { service, accountTokens } = createService();
    accountTokens.findUsable.mockResolvedValue(null);

    await expect(service.verifyEmail('invalid-token', {})).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rate limits verification resend separately and returns a generic result', async () => {
    const { service, users, accountTokens, rateLimiter, recovery } =
      createService();
    users.findForAccountRecovery.mockResolvedValue({
      ...user,
      emailVerifiedAt: null,
    });

    const result = await service.resendVerification(user.email, {
      ipAddress: '192.0.2.1',
    });

    expect(result.message).toContain('If the account requires verification');
    expect(rateLimiter.assertVerificationResendAllowed).toHaveBeenCalledWith(
      '192.0.2.1',
      user.email,
    );
    expect(recovery.enqueue).toHaveBeenCalledWith({
      kind: 'verification',
      userId: user.id,
      requestedAt: expect.any(String),
    });
    expect(accountTokens.issue).not.toHaveBeenCalled();
  });

  it.each([
    [
      'existing eligible unverified account',
      { ...user, emailVerifiedAt: null },
    ],
    ['nonexistent account', null],
  ])(
    'returns the same provider-unavailable response for resend-verification with a %s',
    async (_case, target) => {
      const { service, users, emails, rateLimiter } = createService();
      users.findForAccountRecovery.mockResolvedValue(target);
      emails.assertAvailable.mockImplementation(() => {
        throw new ServiceUnavailableException(
          'Transactional email provider is not configured',
        );
      });

      const request = service.resendVerification('person@example.com', {
        ipAddress: '192.0.2.1',
      });

      await expect(request).rejects.toMatchObject({
        status: 503,
        response: {
          statusCode: 503,
          message: 'Transactional email provider is not configured',
        },
      });
      expect(rateLimiter.assertVerificationResendAllowed).toHaveBeenCalledWith(
        '192.0.2.1',
        'person@example.com',
      );
      expect(users.findForAccountRecovery).not.toHaveBeenCalled();
      expect(emails.assertAvailable).toHaveBeenCalledTimes(1);
    },
  );

  it('does not issue verification for ineligible or already verified users', async () => {
    const { service, users, accountTokens, emails, recovery } = createService();
    users.findForAccountRecovery.mockResolvedValue({
      ...user,
      emailVerifiedAt: new Date(),
    });

    const result = await service.resendVerification(user.email, {});

    expect(result.message).toContain('If the account requires verification');
    expect(recovery.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'verification', userId: null }),
    );
    expect(accountTokens.issue).not.toHaveBeenCalled();
    expect(emails.sendVerification).not.toHaveBeenCalled();
  });

  it('returns a minimal identity without archived or security fields', async () => {
    const { service, users } = createService();
    users.findIdentity.mockResolvedValue({
      ...user,
      failedLoginAttempts: 7,
    });

    await expect(service.me(user.id)).resolves.toEqual({
      id: user.id,
      personId: user.personId,
      email: user.email,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      mustChangePassword: true,
    });
  });
});
