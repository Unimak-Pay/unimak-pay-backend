import {
  type CohortQuery,
  type Page,
  type PaymentNotification,
  type PortalApplicant,
  type PortalClient,
  PortalError,
  type PortalStudent,
} from './portal.port';

const TIMEOUT_MS = 1_500;

/**
 * Real portal client. Endpoint paths are assumptions until the portal API is
 * confirmed. Untested in this phase.
 */
export class HttpPortalClient implements PortalClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  getApplicant(ref: string): Promise<PortalApplicant> {
    return this.request<PortalApplicant>('GET', `/applicants/${encodeURIComponent(ref)}`);
  }

  getStudent(id: string): Promise<PortalStudent> {
    return this.request<PortalStudent>('GET', `/students/${encodeURIComponent(id)}`);
  }

  listCohort(q: CohortQuery): Promise<Page<PortalStudent>> {
    const qs = new URLSearchParams({ page: String(q.page) });
    if (q.intake) qs.set('intake', q.intake);
    if (q.program) qs.set('program', q.program);
    if (q.level !== undefined) qs.set('level', String(q.level));
    return this.request<Page<PortalStudent>>('GET', `/students?${qs.toString()}`);
  }

  async notifyPayment(payload: PaymentNotification): Promise<void> {
    await this.request<unknown>('POST', '/payments/notifications', payload);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path.replace(/^\//, ''), this.baseUrl.replace(/\/?$/, '/')), {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PortalError('UNAVAILABLE', `Portal request failed: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new PortalError('NOT_FOUND', `Not found: ${path}`, 404);
    if (!res.ok) throw new PortalError('UNAVAILABLE', `Portal returned ${res.status}`, res.status);
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new PortalError('BAD_RESPONSE', 'Portal returned invalid JSON', res.status);
    }
  }
}
