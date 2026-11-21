import { BadRequestException, ConflictException } from '@nestjs/common';
import { passwordSchema } from '@hrms/validation';
import { isEmail } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { advisoryLock } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordHasherService } from '../security/password-hasher.service.js';
import { normalizeEmail } from './users.service.js';

/**
 * Deployment bootstrap: creates the first account of an empty deployment so it can then be
 * granted the reserved System Owner role (`authz:bootstrap-owner`). Production has no
 * self-registration and no transactional email provider yet, so without this no account
 * could exist. It refuses as soon as any account exists: every later account is created
 * inside the application by an authorized user, never by this command.
 */
export interface InitialUserInput {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

const NAME_MAX_LENGTH = 100;

export function parseInitialUserInput(
  input: InitialUserInput,
): InitialUserInput {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) {
    throw new BadRequestException('A valid email is required.');
  }
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  for (const [field, value] of [
    ['First name', firstName],
    ['Last name', lastName],
  ] as const) {
    if (!value || value.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `${field} is required (at most ${NAME_MAX_LENGTH} characters).`,
      );
    }
  }
  const password = passwordSchema.safeParse(input.password);
  if (!password.success) {
    throw new BadRequestException(password.error.issues[0].message);
  }
  return { email, firstName, lastName, password: password.data };
}

export async function createInitialUser(
  prisma: PrismaService,
  passwords: PasswordHasherService,
  audit: AuditService,
  rawInput: InitialUserInput,
  now = new Date(),
): Promise<{ userId: string }> {
  const input = parseInitialUserInput(rawInput);
  // Hash outside the transaction (Argon2id is deliberately slow).
  const passwordHash = await passwords.hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    await advisoryLock(tx, 'deployment:initial-user');
    if ((await tx.user.count()) > 0) {
      throw new ConflictException(
        'An account already exists; the initial account can only be created in an empty deployment.',
      );
    }
    const person = await tx.person.create({
      data: { firstName: input.firstName, lastName: input.lastName },
      select: { id: true },
    });
    const user = await tx.user.create({
      data: {
        personId: person.id,
        email: input.email,
        passwordHash,
        status: 'ACTIVE',
        // The operator running this command vouches for the address.
        emailVerifiedAt: now,
        mustChangePassword: false,
        passwordChangedAt: now,
      },
      select: { id: true },
    });
    await audit.write(
      {
        actorUserId: null,
        action: 'INITIAL_USER_CREATED',
        entityType: 'User',
        entityId: user.id,
        metadata: { source: 'cli' },
      },
      tx,
    );
    return { userId: user.id };
  });
}
