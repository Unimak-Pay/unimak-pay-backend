import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../../shared/domain/errors';
import type { PayerKind } from '../../catalog/domain/payer-profile';
import {
  PORTAL_CLIENT,
  PortalError,
  type PortalApplicant,
  type PortalClient,
  type PortalStudent,
} from '../../integrations/portal/portal.port';
import type { PayerSnapshot } from '../domain/payer';

export function fromApplicant(a: PortalApplicant): PayerSnapshot {
  return {
    kind: 'APPLICANT',
    ref: a.applicationRef,
    fullName: a.fullName,
    phone: a.phone,
    programCode: a.programCode,
    department: null,
    level: null,
    finalYear: null,
    residency: a.residency,
    intake: a.intake,
    applicantStatus: a.status,
  };
}

export function fromStudent(s: PortalStudent): PayerSnapshot {
  return {
    kind: 'STUDENT',
    ref: s.studentId,
    fullName: s.fullName,
    phone: s.phone,
    programCode: s.programCode,
    department: s.department,
    level: s.level,
    finalYear: s.finalYear,
    residency: s.residency,
    intake: s.intake,
    applicantStatus: null,
  };
}

/** Fetches a payer from the portal and maps portal errors to domain errors. */
@Injectable()
export class PayerDirectory {
  private readonly logger = new Logger(PayerDirectory.name);

  constructor(@Inject(PORTAL_CLIENT) private readonly portal: PortalClient) {}

  async fetch(kind: PayerKind, ref: string): Promise<PayerSnapshot> {
    try {
      return kind === 'APPLICANT'
        ? fromApplicant(await this.portal.getApplicant(ref))
        : fromStudent(await this.portal.getStudent(ref));
    } catch (err) {
      if (err instanceof PortalError && err.code === 'NOT_FOUND') {
        throw new DomainError('PAYER_NOT_FOUND', `${kind.toLowerCase()} ${ref} not found`);
      }
      if (err instanceof PortalError) {
        this.logger.warn(`Portal ${err.code} for ${kind} ${ref}: ${err.message}`);
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'Student records are unavailable, try again');
      }
      throw err;
    }
  }
}
