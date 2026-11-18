import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, type DomainErrorCode } from '../domain/errors';

const STATUS: Record<DomainErrorCode, HttpStatus> = {
  NOT_FOUND: HttpStatus.NOT_FOUND,
  PAYER_NOT_FOUND: HttpStatus.NOT_FOUND,
  VALIDATION: HttpStatus.BAD_REQUEST,
  AMBIGUOUS_RATE_RULE: HttpStatus.CONFLICT,
  NO_RATE_RULE: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  OBLIGATION_SETTLED: HttpStatus.CONFLICT,
  AMOUNT_BELOW_MIN_INSTALMENT: HttpStatus.UNPROCESSABLE_ENTITY,
  AMOUNT_EXCEEDS_PAYABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  INSTALMENTS_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  FEE_NOT_ACTIVE: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  INVALID_STATE: HttpStatus.CONFLICT,
  UPSTREAM_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  MFA_REQUIRED: HttpStatus.FORBIDDEN,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
};

/** DomainError → { error: { code, message, details } } with a mapped status. */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(err: DomainError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = STATUS[err.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) this.logger.warn(`${err.code}: ${err.message}`);
    res.status(status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
  }
}
