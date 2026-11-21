import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Batch 7C (B11) — the Benefits database triggers are the last line of defence behind the
 * services' own checks. When a concurrent write slips past a check, the trigger's refusal is a
 * conflict (409 with a domain code), not a server error. Only these named refusals are mapped;
 * anything else is an unexpected fault and stays a 500 (logged).
 */
export const BENEFIT_CONSTRAINTS: ReadonlyArray<readonly [string, string]> = [
  [
    "A benefit rate must stay within its plan's dates",
    'BENEFIT_RATE_OUTSIDE_PLAN',
  ],
  ['Rates of a coverage option cannot overlap', 'BENEFIT_RATE_OVERLAP'],
  ['A benefit rate can only be closed earlier', 'BENEFIT_RATE_END_NOT_EARLIER'],
  ['A superseded benefit rate is frozen', 'BENEFIT_RATE_SUPERSEDED'],
  [
    'Elections of an employee for one plan cannot overlap',
    'BENEFIT_ELECTION_OVERLAP',
  ],
  ['A superseded benefit election is frozen', 'BENEFIT_ELECTION_SUPERSEDED'],
  ['Coverage can only be ended earlier', 'BENEFIT_END_NOT_EARLIER'],
  [
    "Coverage must stay within the plan's dates",
    'BENEFIT_COVERAGE_OUTSIDE_PLAN',
  ],
  [
    "Coverage must stay within the sponsoring assignment's dates",
    'BENEFIT_COVERAGE_OUTSIDE_ASSIGNMENT',
  ],
  ['The benefit plan does not accept elections', 'BENEFIT_PLAN_NOT_ACCEPTING'],
  ['The coverage option is archived', 'BENEFIT_ARCHIVED'],
  [
    'A cancelled assignment cannot sponsor benefits',
    'BENEFIT_ASSIGNMENT_CANCELLED',
  ],
  [
    'Dependents can only be covered by a current enrolled election',
    'BENEFIT_ELECTION_SUPERSEDED',
  ],
  [
    'Rates or elections of the plan fall outside its new dates',
    'BENEFIT_PLAN_DATES_CONFLICT',
  ],
];

/** The domain code of a known Benefits trigger refusal, or null. */
export function benefitConstraintCode(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) &&
    !(error instanceof Prisma.PrismaClientUnknownRequestError)
  )
    return null;
  const message = error.message;
  return (
    BENEFIT_CONSTRAINTS.find(([text]) => message.includes(text))?.[1] ?? null
  );
}

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
)
export class BenefitsConstraintFilter implements ExceptionFilter {
  private readonly logger = new Logger(BenefitsConstraintFilter.name);

  catch(exception: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const code = benefitConstraintCode(exception);
    if (code) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code,
        message:
          'The benefits data changed meanwhile and no longer allows this; reload and try again.',
      });
      return;
    }
    this.logger.error(exception.message, exception.stack);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
