import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenGuard } from './access-token.guard.js';
import { AllowDuringPasswordChange } from './allow-during-password-change.decorator.js';

class Routes {
  open() {}
  @AllowDuringPasswordChange()
  allowed() {}
}

describe('AccessTokenGuard', () => {
  function createGuard(
    activeSession = true,
    mustChangePassword = false,
    handler: keyof Routes = 'open',
  ) {
    const accessTokens = {
      verify: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sessionId: 'session-1',
      }),
    };
    const sessions = {
      findActiveByIdAndUser: vi
        .fn()
        .mockResolvedValue(
          activeSession ? { id: 'session-1', mustChangePassword } : null,
        ),
    };
    const guard = new AccessTokenGuard(
      accessTokens as never,
      sessions as never,
      new Reflector(),
    );
    const request = {
      headers: { authorization: 'Bearer valid-token' as string | undefined },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
    };
    return { guard, context, request, accessTokens, sessions };
  }

  it('verifies the bearer token and requires an active database session', async () => {
    const { guard, context, request, sessions } = createGuard();

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(sessions.findActiveByIdAndUser).toHaveBeenCalledWith(
      'session-1',
      'user-1',
      expect.any(Date),
    );
    expect(request).toHaveProperty('auth', {
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('rejects missing tokens, invalid tokens, and inactive sessions', async () => {
    const missing = createGuard();
    missing.context.switchToHttp().getRequest().headers.authorization =
      undefined;
    await expect(
      missing.guard.canActivate(missing.context as never),
    ).rejects.toThrow(UnauthorizedException);

    const inactive = createGuard(false);
    await expect(
      inactive.guard.canActivate(inactive.context as never),
    ).rejects.toThrow(UnauthorizedException);

    const invalid = createGuard();
    invalid.accessTokens.verify.mockRejectedValue(new Error('invalid'));
    await expect(
      invalid.guard.canActivate(invalid.context as never),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('lets a user who must change their password reach only the routes marked for it', async () => {
    const blocked = createGuard(true, true, 'open');
    const refusal = await blocked.guard
      .canActivate(blocked.context as never)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
    });

    const allowed = createGuard(true, true, 'allowed');
    await expect(
      allowed.guard.canActivate(allowed.context as never),
    ).resolves.toBe(true);

    // Without the flag every route stays open, marked or not.
    const unflagged = createGuard(true, false, 'open');
    await expect(
      unflagged.guard.canActivate(unflagged.context as never),
    ).resolves.toBe(true);
  });
});
