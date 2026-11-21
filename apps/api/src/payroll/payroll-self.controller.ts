import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { PayrollSelfService } from './payroll-self.service.js';

/**
 * An employee's own finalized pay. Authorized by the caller's identity only: no payroll.*
 * permission is needed, and none grants access to anyone else's pay here.
 */
@Controller('payroll/me/pay')
@UseGuards(AccessTokenGuard)
export class PayrollSelfController {
  constructor(private readonly self: PayrollSelfService) {}

  @Get()
  list(@AuthUser() identity: AuthenticatedIdentity) {
    return this.self.myPay(identity.userId);
  }

  @Get(':runEmployeeId')
  payslip(
    @Param('runEmployeeId', ParseUUIDPipe) runEmployeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.self.payslip(identity.userId, runEmployeeId);
  }
}
