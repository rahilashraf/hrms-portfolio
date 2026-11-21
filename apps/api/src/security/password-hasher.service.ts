import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';

@Injectable()
export class PasswordHasherService {
  private dummyHash?: Promise<string>;

  constructor(private readonly config: ConfigService) {}

  hashPassword(password: string): Promise<string> {
    return hash(password, {
      type: argon2id,
      memoryCost: this.config.getOrThrow<number>('ARGON2_MEMORY_COST_KIB'),
      timeCost: this.config.getOrThrow<number>('ARGON2_TIME_COST'),
      parallelism: this.config.getOrThrow<number>('ARGON2_PARALLELISM'),
    });
  }

  verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }

  async verifyDummyPassword(password: string): Promise<void> {
    this.dummyHash ??= this.hashPassword(randomBytes(32).toString('hex'));
    await verify(await this.dummyHash, password);
  }
}
