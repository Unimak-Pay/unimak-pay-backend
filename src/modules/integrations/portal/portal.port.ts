/** Port to the university portal (system of record for applicants/students). */
export const PORTAL_CLIENT = Symbol('PortalClient');

export type Residency = 'LOCAL' | 'INTERNATIONAL';

export interface PortalApplicant {
  applicationRef: string;
  fullName: string;
  phone: string;
  programCode: string;
  intake: string;
  residency: Residency;
  status: 'APPLIED' | 'ADMITTED' | 'REJECTED';
}

export interface PortalStudent {
  studentId: string;
  fullName: string;
  phone: string;
  programCode: string;
  department: string;
  level: number;
  finalYear: boolean;
  residency: Residency;
  intake: string;
}

export interface CohortQuery {
  intake?: string;
  program?: string;
  level?: number;
  page: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PaymentNotification {
  event: 'application_paid';
  applicationRef: string;
  receiptNumber: string;
  /** minor units, as a string */
  amount: string;
  currency: 'SLE';
  paidAt: string;
}

export type PortalErrorCode = 'NOT_FOUND' | 'UNAVAILABLE' | 'BAD_RESPONSE';

/** The single error shape every PortalClient implementation throws. */
export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PortalError';
  }
}

export interface PortalClient {
  getApplicant(ref: string): Promise<PortalApplicant>;
  getStudent(id: string): Promise<PortalStudent>;
  listCohort(query: CohortQuery): Promise<Page<PortalStudent>>;
  notifyPayment(payload: PaymentNotification): Promise<void>;
}
