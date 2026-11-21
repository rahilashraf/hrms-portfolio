import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordHasherService } from '../security/password-hasher.service.js';
import { createInitialUser, parseInitialUserInput } from './initial-user.js';

const input = {
  email: '  Owner@Example.COM ',
  firstName: ' Ada ',
  lastName: 'Lovelace',
  password: 'correct horse battery staple',
};

function setup(existingUsers: number) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: {
      count: vi.fn().mockResolvedValue(existingUsers),
      create: vi.fn().mockResolvedValue({ id: 'user-1' }),
    },
    person: { create: vi.fn().mockResolvedValue({ id: 'person-1' }) },
  };
  const prisma = {
    $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const passwords = {
    hashPassword: vi.fn().mockResolvedValue('argon2id-hash'),
  } as unknown as PasswordHasherService;
  const audit = {
    write: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;
  return { tx, prisma, passwords, audit };
}

describe('parseInitialUserInput', () => {
  it('normalizes the email and trims names', () => {
    expect(parseInitialUserInput(input)).toEqual({
      email: 'owner@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: input.password,
    });
  });

  it('rejects an invalid email, a blank name or a short password', () => {
    expect(() => parseInitialUserInput({ ...input, email: 'owner' })).toThrow(
      BadRequestException,
    );
    expect(() => parseInitialUserInput({ ...input, lastName: '  ' })).toThrow(
      /Last name/,
    );
    expect(() =>
      parseInitialUserInput({ ...input, password: 'Admin123!' }),
    ).toThrow(/12 and 128/);
  });
});

describe('createInitialUser', () => {
  it('creates one active, verified account with a hashed password and an audit entry', async () => {
    const { tx, prisma, passwords, audit } = setup(0);
    const now = new Date('2026-10-07T12:00:00Z');

    await expect(
      createInitialUser(prisma, passwords, audit, input, now),
    ).resolves.toEqual({ userId: 'user-1' });

    expect(passwords.hashPassword).toHaveBeenCalledWith(input.password);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.person.create).toHaveBeenCalledWith({
      data: { firstName: 'Ada', lastName: 'Lovelace' },
      select: { id: true },
    });
    expect(tx.user.create).toHaveBeenCalledWith({
      data: {
        personId: 'person-1',
        email: 'owner@example.com',
        passwordHash: 'argon2id-hash',
        status: 'ACTIVE',
        emailVerifiedAt: now,
        mustChangePassword: false,
        passwordChangedAt: now,
      },
      select: { id: true },
    });
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INITIAL_USER_CREATED',
        entityId: 'user-1',
        actorUserId: null,
      }),
      tx,
    );
    // The password itself never reaches the database or the audit log.
    expect(JSON.stringify(vi.mocked(audit.write).mock.calls)).not.toContain(
      input.password,
    );
  });

  it('refuses once any account exists', async () => {
    const { tx, prisma, passwords, audit } = setup(1);

    await expect(
      createInitialUser(prisma, passwords, audit, input),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.person.create).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('validates before hashing or touching the database', async () => {
    const { prisma, passwords, audit } = setup(0);

    await expect(
      createInitialUser(prisma, passwords, audit, {
        ...input,
        password: 'short',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
