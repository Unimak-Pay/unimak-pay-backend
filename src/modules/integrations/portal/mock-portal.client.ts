import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type CohortQuery,
  type Page,
  type PaymentNotification,
  type PortalApplicant,
  type PortalClient,
  PortalError,
  type PortalStudent,
} from './portal.port';

const PAGE_SIZE = 50;

/**
 * Reads fixtures/portal/*.json. Simulates latency and the real client's errors:
 * - unknown ref → PortalError NOT_FOUND (what HttpPortalClient throws on 404)
 * - ref starting with "ERR-" → PortalError UNAVAILABLE (what it throws on timeout/5xx)
 */
export class MockPortalClient implements PortalClient {
  constructor(
    private readonly fixturesDir: string,
    private readonly latencyMs: number,
  ) {}

  async getApplicant(ref: string): Promise<PortalApplicant> {
    await this.simulate(ref);
    const found = (await this.read<PortalApplicant[]>('applicants.json')).find(
      (a) => a.applicationRef === ref,
    );
    if (!found) throw new PortalError('NOT_FOUND', `Applicant ${ref} not found`, 404);
    return found;
  }

  async getStudent(id: string): Promise<PortalStudent> {
    await this.simulate(id);
    const found = (await this.read<PortalStudent[]>('students.json')).find(
      (s) => s.studentId === id,
    );
    if (!found) throw new PortalError('NOT_FOUND', `Student ${id} not found`, 404);
    return found;
  }

  async listCohort(q: CohortQuery): Promise<Page<PortalStudent>> {
    await this.simulate();
    const all = (await this.read<PortalStudent[]>('students.json')).filter(
      (s) =>
        (q.intake === undefined || s.intake === q.intake) &&
        (q.program === undefined || s.programCode === q.program) &&
        (q.level === undefined || s.level === q.level),
    );
    const page = Math.max(1, q.page);
    return {
      items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      page,
      pageSize: PAGE_SIZE,
      total: all.length,
    };
  }

  async notifyPayment(payload: PaymentNotification): Promise<void> {
    await this.simulate();
    const file = this.file('notifications.log.json');
    let log: unknown[] = [];
    try {
      log = JSON.parse(await fs.readFile(file, 'utf8')) as unknown[];
    } catch {
      log = [];
    }
    log.push({ receivedAt: new Date().toISOString(), payload });
    await fs.writeFile(file, JSON.stringify(log, null, 2) + '\n');
  }

  private async simulate(ref?: string): Promise<void> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (ref?.startsWith('ERR-')) throw new PortalError('UNAVAILABLE', 'Portal unavailable', 503);
  }

  private file(name: string): string {
    return path.resolve(process.cwd(), this.fixturesDir, name);
  }

  private async read<T>(name: string): Promise<T> {
    return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T;
  }
}
