import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitedException } from './rate-limit.js';

/** Sends a RateLimitedException as 429 with Retry-After (seconds). */
@Catch(RateLimitedException)
export class RateLimitExceptionFilter implements ExceptionFilter {
  catch(exception: RateLimitedException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(exception.getStatus())
      .setHeader('Retry-After', String(exception.retryAfterSeconds))
      .json(exception.getResponse());
  }
}
