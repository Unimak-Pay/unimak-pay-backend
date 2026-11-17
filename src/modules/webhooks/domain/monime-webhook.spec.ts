import { signMonimePayload, verifyMonimeSignature } from './monime-signature';
import { InvalidWebhookPayloadError, parseCompletedPayment, parseMonimeWebhook } from './monime-webhook';

const SECRET = 'test-secret-0123456789abcdef';

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
    })));
    expect(parsed).toEqual({
      monimePaymentId: 'spm-1', financialAccountId: 'fa-unimak-application', currency: 'SLE', amount: 15_000n, fees: 150n,
      reference: '11111111-2222-3333-4444-555555555555',
      metadata: { paymentId: 'from-payment', source: 'ussd', n: '3' },
      ownerId: 'pmc-1', ownerType: 'payment_code',
    });
  });

  it('falls back to object.id for the payment id; rejects bad amounts', () => {
    expect(parseCompletedPayment(parseMonimeWebhook(envelope({ amount: { currency: 'SLE', value: '10' } }))).monimePaymentId).toBe('spm-1');
    expect(() => parseCompletedPayment(parseMonimeWebhook(envelope({ amount: { currency: 'SLE', value: 1.5 } })))).toThrow(InvalidWebhookPayloadError);
    expect(() => parseCompletedPayment(parseMonimeWebhook(envelope({ amount: { currency: 'SLE', value: 0 } })))).toThrow(/positive/);
  });
});
