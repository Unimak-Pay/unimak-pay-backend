import { signMonimePayload, verifyMonimeSignature } from './monime-signature';
import { InvalidWebhookPayloadError, parseCompletedPayment, parseMonimeWebhook } from './monime-webhook';

const SECRET = 'test-secret-0123456789abcdef0123456789';

describe('Monime signature', () => {
  const body = Buffer.from('{"event":{"id":"evt-1","name":"x"}}');

  it('accepts a valid signature', () => {
    const header = signMonimePayload(body, SECRET, '1794920000');
    expect(verifyMonimeSignature({ rawBody: body, header, secret: SECRET })).toEqual({ valid: true, timestamp: '1794920000' });
  });

  it('matches base64(HMAC-SHA256(secret, "<t>_" + body))', () => {
    const header = signMonimePayload('hello', 'k', '1');
    // echo -n '1_hello' | openssl dgst -sha256 -hmac k -binary | base64
    expect(header).toBe('t=1,v1=' + require('node:crypto').createHmac('sha256', 'k').update('1_hello').digest('base64'));
  });

  it('rejects tampered bodies, wrong secrets and missing/malformed headers', () => {
    const header = signMonimePayload(body, SECRET, '1794920000');
    expect(verifyMonimeSignature({ rawBody: Buffer.from(body.toString() + ' '), header, secret: SECRET })).toMatchObject({ valid: false, reason: 'Invalid signature' });
    expect(verifyMonimeSignature({ rawBody: body, header, secret: SECRET + 'x' }).valid).toBe(false);
    expect(verifyMonimeSignature({ rawBody: body, header: undefined, secret: SECRET })).toMatchObject({ reason: 'Missing Monime-Signature header' });
    expect(verifyMonimeSignature({ rawBody: body, header: 'v1=abc', secret: SECRET })).toMatchObject({ reason: 'Malformed Monime-Signature header' });
  });

  it('enforces tolerance when configured (seconds or ms timestamps)', () => {
    const now = new Date(1_794_920_000_000);
    const old = signMonimePayload(body, SECRET, String(1_794_920_000 - 400));
    const ms = signMonimePayload(body, SECRET, String(1_794_920_000_000 - 10_000));
    expect(verifyMonimeSignature({ rawBody: body, header: old, secret: SECRET, toleranceSeconds: 300, now }).valid).toBe(false);
    expect(verifyMonimeSignature({ rawBody: body, header: old, secret: SECRET, now }).valid).toBe(true);
    expect(verifyMonimeSignature({ rawBody: body, header: ms, secret: SECRET, toleranceSeconds: 300, now }).valid).toBe(true);
  });
});

describe('Monime webhook parsing', () => {
  const envelope = (data: Record<string, unknown>) => ({
    apiVersion: 'caph.2025-08-23',
    event: { id: 'evt-1', name: 'payment.processing_completed', timestamp: '2026-11-17T12:00:00Z' },
    object: { id: 'spm-1', type: 'payment' },
    data,
  });

  it('requires event id and name', () => {
    expect(() => parseMonimeWebhook({ event: { name: 'x' } })).toThrow(InvalidWebhookPayloadError);
    expect(() => parseMonimeWebhook('nope')).toThrow(InvalidWebhookPayloadError);
  });

  it('reads a completed Payment', () => {
    const parsed = parseCompletedPayment(parseMonimeWebhook(envelope({
      id: 'spm-1', status: 'completed',
      amount: { currency: 'SLE', value: 15_000 },
      financialAccountId: 'fa-unimak-application',
      reference: '11111111-2222-3333-4444-555555555555',
      fees: [{ code: 'processing', amount: { currency: 'SLE', value: 150 } }, { code: 'x', amount: { currency: 'USD', value: 9 } }],
      ownershipGraph: { owner: { id: 'pmc-1', type: 'payment_code', metadata: { paymentId: 'from-owner', source: 'ussd' } } },
      metadata: { paymentId: 'from-payment', n: 3 },
      // as in a real payload: Monime masks the paying number
      channel: { type: 'momo', provider: 'm17', phoneNumber: '+23276****56' },
      orderNumber: '3BMRXXXQXJW3',
    })));
    expect(parsed).toEqual({
      monimePaymentId: 'spm-1', financialAccountId: 'fa-unimak-application', currency: 'SLE', amount: 15_000n, fees: 150n,
      reference: '11111111-2222-3333-4444-555555555555',
      metadata: { paymentId: 'from-payment', source: 'ussd', n: '3' },
      ownerId: 'pmc-1', ownerType: 'payment_code', payerPhone: '+23276****56', orderNumber: '3BMRXXXQXJW3', channelType: 'momo',
    });
  });

  it('falls back to object.id for the payment id; rejects bad amounts', () => {
    expect(parseCompletedPayment(parseMonimeWebhook(envelope({ amount: { currency: 'SLE', value: '10' } }))).monimePaymentId).toBe('spm-1');
    expect(() => parseCompletedPayment(parseMonimeWebhook(envelope({ amount: { currency: 'SLE', value: 1.5 } })))).toThrow(InvalidWebhookPayloadError);
    expect(() => parseCompletedPayment(parseMonimeWebhook(envelope({ amount: { currency: 'SLE', value: 0 } })))).toThrow(/positive/);
  });
});

describe('treasury event parsing', () => {
  const env = (name: string, object: Record<string, unknown>, data: Record<string, unknown>) =>
    parseMonimeWebhook({ apiVersion: 'caph.2025-08-23', event: { id: 'evt-x', name, timestamp: '1773386779' }, object, data });

  it('reads internal_transfer.* (InternalTransfer object)', () => {
    const { parseInternalTransfer } = jest.requireActual('./monime-webhook');
    expect(parseInternalTransfer(env('internal_transfer.failed', { id: 'trn-1', type: 'internal_transfer' }, {
      id: 'trn-1', status: 'failed', amount: { currency: 'SLE', value: 750 },
      failureDetail: { code: 'fund_insufficient', message: 'Not enough funds' }, metadata: { transferId: 't-1' },
    }))).toEqual({ monimeTransferId: 'trn-1', amount: 750n, failure: { code: 'fund_insufficient', message: 'Not enough funds' }, metadata: { transferId: 't-1' } });
  });

  it('reads payout.* with fees (Payout object)', () => {
    const { parsePayout } = jest.requireActual('./monime-webhook');
    expect(parsePayout(env('payout.completed', { id: 'pyt-1', type: 'payout' }, {
      id: 'pyt-1', status: 'completed', amount: { currency: 'SLE', value: 100000 },
      fees: [{ code: 'payout', amount: { currency: 'SLE', value: 500 } }], metadata: { payoutId: 'p-1' },
    }))).toEqual({ monimePayoutId: 'pyt-1', amount: 100000n, fees: 500n, failure: null, metadata: { payoutId: 'p-1' } });
  });

  it('reads financial_account.* in the AccountCredited shape (fac_events)', () => {
    const { parseAccountMovement } = jest.requireActual('./monime-webhook');
    expect(parseAccountMovement(env('financial_account.credited', { id: 'fac-1', type: 'financial_account' }, {
      transactionId: 'txn-1', transactionReference: 'ref-9', amount: { currency: 'SLE', value: '15000' },
      newBalance: { currency: 'SLE', value: '99000' }, creditTime: '2026-11-18T09:00:00Z', metadata: {},
    }))).toEqual({ accountId: 'fac-1', amount: 15000n, balanceAfter: 99000n, transactionId: 'txn-1', transactionReference: 'ref-9', at: new Date('2026-11-18T09:00:00Z') });
    // nested under debited, account inside data
    expect(parseAccountMovement(env('financial_account.debited', {}, {
      account: { id: 'fac-2' }, debited: { amount: { currency: 'SLE', value: 500 }, newBalance: { currency: 'SLE', value: 42 }, debitTime: '2026-11-18T10:00:00Z' },
    }))).toMatchObject({ accountId: 'fac-2', amount: 500n, balanceAfter: 42n });
  });

  it('falls back to other shapes and never throws', () => {
    const { parseAccountMovement } = jest.requireActual('./monime-webhook');
    expect(parseAccountMovement(env('financial_account.credited', { id: 'txn-1', type: 'financial_transaction' }, {
      id: 'txn-1', amount: { currency: 'SLE', value: 15000 }, financialAccount: { id: 'fac-1', balance: { after: { currency: 'SLE', value: 99000 } } },
    }))).toMatchObject({ accountId: 'fac-1', balanceAfter: 99000n });
    expect(parseAccountMovement(env('financial_account.credited', {}, { foo: 1 }))).toMatchObject({ accountId: null, amount: null, balanceAfter: null });
  });
});

describe('eventTime', () => {
  const { eventTime } = jest.requireActual('./monime-webhook');
  const at = (timestamp: string | null) => eventTime({ apiVersion: null, event: { id: 'e', name: 'n', timestamp }, object: { id: null, type: null }, data: {} }, new Date(0));
  it('reads unix seconds, ms and ISO; falls back otherwise', () => {
    expect(at('1773386779').toISOString()).toBe('2026-03-13T07:26:19.000Z');
    expect(at('1773386779000').toISOString()).toBe('2026-03-13T07:26:19.000Z');
    expect(at('2026-11-17T12:00:00Z').toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect(at('nope').getTime()).toBe(0);
    expect(at(null).getTime()).toBe(0);
  });
});
