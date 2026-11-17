import { HttpMonimeClient } from './http-monime.client';
import { MonimeError } from './monime.port';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500, body: null };
    return new Response(r.body === null ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (result: unknown) => ({ status: 200, body: { success: true, messages: [], result } });
const cfg = { baseUrl: 'https://api.monime.io/v1/', accessToken: 'tok', spaceId: 'spc-1', apiVersion: 'caph.2025-08-23', retryBaseDelayMs: 1 };
const body = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;
const headers = (c: Call) => c.init.headers as Record<string, string>;

describe('HttpMonimeClient request shapes (caph.2025-08-23)', () => {
  it('creates a one-time payment code into the fee account', async () => {
    const f = fakeFetch([ok({ id: 'pmc-1', status: 'pending', ussdCode: '*715*1*123#', expireTime: 't', reference: 'pay-1', amount: { currency: 'SLE', value: 15000 } })]);
    const res = await new HttpMonimeClient(cfg, f.fn).createPaymentCode({
      idempotencyKey: 'pay-1', name: 'UNIMAK Application fee', amount: 15_000n, durationMinutes: 15,
      reference: 'pay-1', authorizedPhoneNumber: '+23276100001', financialAccountId: 'fac-app', metadata: { paymentId: 'pay-1' },
    });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.monime.io/v1/payment-codes');
    expect(c.init.method).toBe('POST');
    expect(headers(c)).toMatchObject({
      Authorization: 'Bearer tok', 'Monime-Space-Id': 'spc-1', 'Monime-Version': 'caph.2025-08-23', 'Idempotency-Key': 'pay-1', 'Content-Type': 'application/json',
    });
    expect(body(c)).toEqual({
      mode: 'one_time', name: 'UNIMAK Application fee', amount: { currency: 'SLE', value: 15000 }, duration: '15m',
      reference: 'pay-1', authorizedPhoneNumber: '+23276100001', financialAccountId: 'fac-app', metadata: { paymentId: 'pay-1' },
    });
    expect(res).toEqual({ id: 'pmc-1', status: 'pending', ussdCode: '*715*1*123#', expireTime: 't', reference: 'pay-1', amount: 15_000n });
  });

  it('creates a financial account with a unique reference; finds by reference', async () => {
    const f = fakeFetch([
      ok({ id: 'fac-1', uvan: '123', name: 'UNIMAK Tuition', currency: 'SLE', reference: 'unimak-fee-tuition' }),
      ok([{ id: 'fac-1', name: 'x', currency: 'SLE', reference: 'unimak-fee-tuition' }]),
      ok({ id: 'fac-1', name: 'x', currency: 'SLE', balance: { available: { currency: 'SLE', value: 99 } } }),
    ]);
    const c = new HttpMonimeClient(cfg, f.fn);
    await c.createFinancialAccount({ idempotencyKey: 'provision-unimak-fee-tuition', name: 'UNIMAK Tuition', currency: 'SLE', reference: 'unimak-fee-tuition' });
    expect(f.calls[0]!.url).toBe('https://api.monime.io/v1/financial-accounts');
    expect(body(f.calls[0]!)).toEqual({ name: 'UNIMAK Tuition', currency: 'SLE', reference: 'unimak-fee-tuition' });
    expect((await c.findFinancialAccountByReference('unimak-fee-tuition'))?.id).toBe('fac-1');
    expect(f.calls[1]!.url).toBe('https://api.monime.io/v1/financial-accounts?reference=unimak-fee-tuition&limit=1');
    expect((await c.getFinancialAccount('fac-1', { withBalance: true })).available).toBe(99n);
    expect(f.calls[2]!.url).toBe('https://api.monime.io/v1/financial-accounts/fac-1?withBalance=true');
  });

  it('creates an internal transfer (no description field: additionalProperties=false)', async () => {
    const f = fakeFetch([ok({ id: 'trn-1', status: 'pending', amount: { currency: 'SLE', value: 750 } })]);
    const res = await new HttpMonimeClient(cfg, f.fn).createInternalTransfer({
      idempotencyKey: 'commission-p1', amount: 750n, sourceAccountId: 'fac-app', destinationAccountId: 'fac-plat', metadata: { paymentId: 'p1' },
    });
    expect(f.calls[0]!.url).toBe('https://api.monime.io/v1/internal-transfers');
    expect(body(f.calls[0]!)).toEqual({
      amount: { currency: 'SLE', value: 750 }, sourceFinancialAccount: { id: 'fac-app' }, destinationFinancialAccount: { id: 'fac-plat' }, metadata: { paymentId: 'p1' },
    });
    expect(res).toEqual({ id: 'trn-1', status: 'pending', amount: 750n, failure: null });
  });

  it('creates a bank payout and sums fees', async () => {
    const f = fakeFetch([ok({ id: 'pyt-1', status: 'pending', amount: { currency: 'SLE', value: 100000 }, fees: [{ code: 'x', amount: { currency: 'SLE', value: 300 } }] })]);
    const res = await new HttpMonimeClient(cfg, f.fn).createPayout({
      idempotencyKey: 'po-1', amount: 100_000n, sourceAccountId: 'fac-tui',
      destination: { type: 'bank', providerId: 'slb001', accountNumber: '0123456789' }, metadata: { payoutId: 'po-1' },
    });
    expect(f.calls[0]!.url).toBe('https://api.monime.io/v1/payouts');
    expect(body(f.calls[0]!)).toEqual({
      amount: { currency: 'SLE', value: 100000 }, source: { financialAccountId: 'fac-tui' },
      destination: { type: 'bank', providerId: 'slb001', accountNumber: '0123456789' }, metadata: { payoutId: 'po-1' },
    });
    expect(res.fees).toBe(300n);
  });

  it('lists banks and registers an HS256 webhook', async () => {
    const f = fakeFetch([
      ok([{ providerId: 'slb001', name: 'SLCB', status: { active: true }, featureSet: { payout: { canPayTo: true } } }]),
      ok({ id: 'whk-1' }),
    ]);
    const c = new HttpMonimeClient(cfg, f.fn);
    expect(await c.listBanks('SL')).toEqual([{ providerId: 'slb001', name: 'SLCB', active: true, canPayTo: true }]);
    expect(f.calls[0]!.url).toBe('https://api.monime.io/v1/banks?country=SL&limit=50');
    await c.createWebhook({ idempotencyKey: 'wh-1', name: 'UNIMAK', url: 'https://x.test/webhooks/monime', events: ['payout.completed'], secret: 's'.repeat(32) });
    expect(body(f.calls[1]!)).toEqual({
      name: 'UNIMAK', url: 'https://x.test/webhooks/monime', enabled: true, apiRelease: 'caph',
      events: ['payout.completed'], verificationMethod: { type: 'HS256', secret: 's'.repeat(32) },
    });
  });
});

describe('HttpMonimeClient errors', () => {
  it('retries 5xx/429 with the same idempotency key, then succeeds', async () => {
    const f = fakeFetch([{ status: 503, body: null }, { status: 429, body: null }, ok({ id: 'trn-1', status: 'completed', amount: { currency: 'SLE', value: 1 } })]);
    await new HttpMonimeClient(cfg, f.fn).createInternalTransfer({ idempotencyKey: 'k', amount: 1n, sourceAccountId: 'a', destinationAccountId: 'b', metadata: {} });
    expect(f.calls).toHaveLength(3);
    expect(f.calls.map((c) => headers(c)['Idempotency-Key'])).toEqual(['k', 'k', 'k']);
  });

  it('maps 4xx to REJECTED with Monime’s message, 404 to NOT_FOUND, no retry', async () => {
    const f = fakeFetch([{ status: 400, body: { success: false, error: { code: 'invalid', message: 'bad amount' } } }, { status: 404, body: null }]);
    const c = new HttpMonimeClient(cfg, f.fn);
    await expect(c.getPayout('pyt-x')).rejects.toMatchObject({ code: 'REJECTED', message: 'bad amount', status: 400 });
    await expect(c.getPayout('pyt-y')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.calls).toHaveLength(2);
  });

  it('refuses missing or over-long idempotency keys before calling Monime', async () => {
    const f = fakeFetch([]);
    const c = new HttpMonimeClient(cfg, f.fn);
    await expect(c.createPayout({ idempotencyKey: 'x'.repeat(65), amount: 1n, sourceAccountId: 'a', destination: { type: 'bank', providerId: 'slb001', accountNumber: '1234' }, metadata: {} }))
      .rejects.toBeInstanceOf(MonimeError);
    expect(f.calls).toHaveLength(0);
  });
});
