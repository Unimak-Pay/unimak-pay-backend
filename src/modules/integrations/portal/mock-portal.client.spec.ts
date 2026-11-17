import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockPortalClient } from './mock-portal.client';
import { PortalError } from './portal.port';

describe('MockPortalClient', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  cpSync(path.resolve('fixtures/portal'), dir, { recursive: true });
  const client = new MockPortalClient(dir, 0);

  it('finds applicants and students', async () => {
    await expect(client.getApplicant('APP-2026-0001')).resolves.toMatchObject({ fullName: 'Aminata Kamara' });
    await expect(client.getStudent('UNI-2023-0004')).resolves.toMatchObject({ finalYear: true });
  });

  it('throws the real client error shape on not found / unavailable', async () => {
    await expect(client.getStudent('NOPE')).rejects.toEqual(expect.any(PortalError));
    await expect(client.getStudent('NOPE')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(client.getApplicant('ERR-1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('filters and pages cohorts', async () => {
    const page = await client.listCohort({ program: 'BSC-CS', page: 1 });
    expect(page.total).toBe(4);
  });

  it('appends notifications to the log file', async () => {
    await client.notifyPayment({
      event: 'application_paid', applicationRef: 'APP-2026-0001', receiptNumber: 'UNIMAK-2026-000001',
      amount: '15000', currency: 'SLE', paidAt: new Date().toISOString(),
    });
    const log = JSON.parse(readFileSync(path.join(dir, 'notifications.log.json'), 'utf8')) as unknown[];
    expect(log).toHaveLength(1);
  });

  it('applies artificial latency', async () => {
    const slow = new MockPortalClient(dir, 50);
    const t = Date.now();
    await slow.getStudent('UNI-2026-0001');
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
  });
});
