import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountEmailMessage,
  AccountEmailService,
  accountEmailUnavailable,
} from './account-email.service.js';

@Injectable()
export class DevAccountEmailService extends AccountEmailService {
  private readonly production: boolean;
  readonly messages: Array<{
    type: 'password-reset' | 'invitation' | 'verification';
    message: AccountEmailMessage;
  }> = [];

  constructor(config: ConfigService) {
    super();
    this.production = config.getOrThrow<string>('NODE_ENV') === 'production';
  }

  assertAvailable(): void {
    if (this.production) {
      throw accountEmailUnavailable(
        'Transactional email provider is not configured',
      );
    }
  }

  async sendPasswordReset(message: AccountEmailMessage): Promise<void> {
    this.assertAvailable();
    this.messages.push({ type: 'password-reset', message });
  }

  async sendInvitation(message: AccountEmailMessage): Promise<void> {
    this.assertAvailable();
    this.messages.push({ type: 'invitation', message });
  }

  async sendVerification(message: AccountEmailMessage): Promise<void> {
    this.assertAvailable();
    this.messages.push({ type: 'verification', message });
  }
}
