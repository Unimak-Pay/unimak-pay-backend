/**
 * Domain/application errors carry a stable code. The interface layer maps
 * codes to HTTP statuses; domain code never knows about HTTP.
 */
export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'PAYER_NOT_FOUND'
  | 'VALIDATION'
  | 'AMBIGUOUS_RATE_RULE'
  | 'NO_RATE_RULE'
  | 'FORBIDDEN'
  | 'OBLIGATION_SETTLED'
  | 'AMOUNT_BELOW_MIN_INSTALMENT'
  | 'AMOUNT_EXCEEDS_PAYABLE'
  | 'INSTALMENTS_NOT_ALLOWED'
  | 'FEE_NOT_ACTIVE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UNAUTHENTICATED'
  | 'MFA_REQUIRED'
  | 'RATE_LIMITED'
  | 'ALIAS_MISMATCH'
  | 'ALIAS_REQUIRED';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
