import { createPublicKey, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { ussdSubscriberIdFor } from '../../src/shared/domain/phone';
import { decryptReply, encryptAsMonime } from '../../src/modules/ussd/domain/exchange-crypto';
import { monimeEvent } from './helpers';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();
const URL = `/v1/ussd/exchange/${process.env.USSD_EXCHANGE_PATH_TOKEN}`;
const SUBSCRIBER = randomUUID();

type Nav = { action: 'navigate'; pageId: string; pageData: Record<string, unknown> & { fees?: { value: string; label: string }[] } };
type Reply = Nav | { action: 'stop'; message: string };

/** One exchange call, encrypted exactly like Monime does it. */
async function exchange(session: string, currentPage: string, flowData: Record<string, string>, opts: { subscriberId?: string; previousKey?: boolean } = {}): Promise<Reply> {
  const pub = createPublicKey(opts.previousKey ? process.env.E2E_USSD_PREVIOUS_PUBLIC_KEY! : process.env.E2E_USSD_PUBLIC_KEY!);
  const payload = {
    global: { sessionId: session, networkName: 'Orange', subscriberId: opts.subscriberId ?? SUBSCRIBER, subscriberMsisdn: '+23276****56', networkProviderName: 'Orange Money' },
    currentPage,
    flowData,
  };
  const { body, aesKey } = encryptAsMonime(payload, pub);
  const res = await http.post(URL).set('content-type', 'application/json').send(body).expect(200);
  expect(res.headers['content-type']).toMatch(/^text\/plain/);
  return decryptReply(res.text, aesKey) as Reply;
}

/** A USSD session that accumulates flowData like Monime does (keyed by page id). */
function session(subscriberId: string = SUBSCRIBER) {
  const id = `sess-${randomUUID()}`;
  const flow: Record<string, string> = {};
  return {
    id,
    step: (page: string, value: string, opts: { previousKey?: boolean } = {}) => {
      flow[page] = value;
      return exchange(id, page, { ...flow }, { subscriberId, ...opts });
    },
  };
}

async function toPayer(intent: string, kind: 'student' | 'applicant', ref: string, subscriberId: string = SUBSCRIBER) {
  const s = session(subscriberId);
  expect(await s.step('home', intent)).toEqual({ action: 'navigate', pageId: 'id_type', pageData: {} });
  const prompt = await s.step('id_type', kind);
  expect(prompt).toMatchObject({ pageId: kind === 'student' ? 'enter_student_id' : 'enter_application_ref' });
  const page = kind === 'student' ? 'enter_student_id' : 'enter_application_ref';
  return { s, page, reply: await s.step(page, ref) };
}

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('USSD exchange endpoint security', () => {
  it('hides behind the secret path token', async () => {
    await http.post('/v1/ussd/exchange/wrong-token').send({}).expect(404);
    await http.get(URL).expect(200);
  });

  it('refuses plaintext and undecryptable / tampered requests', async () => {
    await http.post(URL).send({ global: { sessionId: 'x', subscriberId: 'y' }, currentPage: 'home', flowData: { home: 'pay' } }).expect(400);
    const { body } = encryptAsMonime({ currentPage: 'home' }, createPublicKey(process.env.E2E_USSD_PUBLIC_KEY!));
    const blob = Buffer.from(body.encryptedExchangeData, 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    const res = await http.post(URL).send({ ...body, encryptedExchangeData: blob.toString('base64') }).expect(400);
    expect(res.body).toEqual({ action: 'stop', message: 'Decryption failed' });
  });

  it('accepts the previous key during rotation', async () => {
    expect(await session().step('home', 'pay', { previousKey: true })).toMatchObject({ action: 'navigate', pageId: 'id_type' });
  });

  it('ignores flowData that skips ahead (server-side session state)', async () => {
    const s = session();
    await s.step('home', 'pay');
    expect(await s.step('confirm_payment', 'confirm')).toEqual({ action: 'stop', message: 'Session expired. Please dial again.' });
    // a session id replayed by another subscriber
    const t = session();
    await t.step('home', 'pay');
    expect(await exchange(t.id, 'id_type', { home: 'pay', id_type: 'student' }, { subscriberId: randomUUID() })).toMatchObject({ action: 'stop' });
  });

  it('rate-limits ID lookups per subscriber', async () => {
    const sub = randomUUID();
    for (let i = 0; i < 4; i++) {
      // each session: 1 lookup + 2 retries = 3 lookups
      const { s, page } = await toPayer('balance', 'student', 'NOPE-1', sub);
      await s.step('try_again', 'retry');
      await s.step(page, 'NOPE-2');
      await s.step('try_again', 'retry');
      const last = await s.step(page, 'NOPE-3');
      expect(last).toEqual({
        action: 'stop',
        message: i < 3 ? 'Student ID not found. Please check it and try again later.' : 'Too many lookups. Please try again later.',
      });
    }
  });
});

describe('USSD menus', () => {
  it('help ends the session with the finance office number', async () => {
    expect(await session().step('home', 'help')).toMatchObject({ action: 'stop', message: expect.stringMatching(/Finance Office/) });
  });

  it('wrong ID: try again twice, then the session ends; cancel ends it too', async () => {
    const { s, page, reply } = await toPayer('pay', 'student', 'uni-0000');
    expect(reply).toEqual({ action: 'navigate', pageId: 'try_again', pageData: { message: 'Student ID UNI-0000 not found.' } });
    expect(await s.step('try_again', 'retry')).toEqual({ action: 'navigate', pageId: page, pageData: {} });
    expect(await s.step(page, 'UNI-0001')).toMatchObject({ pageId: 'try_again' });
    await s.step('try_again', 'retry');
    expect(await s.step(page, 'UNI-0002')).toMatchObject({ action: 'stop' });

    const c = await toPayer('pay', 'applicant', 'APP-0000');
    expect(await c.s.step('try_again', 'cancel')).toEqual({ action: 'stop', message: 'Cancelled.' });
  });

  it('check balance lists fees with balances', async () => {
    const { reply } = await toPayer('balance', 'student', 'uni-2025-0003');
    expect(reply).toMatchObject({ action: 'stop', message: expect.stringMatching(/^C\*\*\* O\*\*\*\nTuition 2026\/27: SLE /) });
  });
});

describe('USSD payment journey (collect_payment)', () => {
  let paymentId: string;

  it('student pays a tuition instalment; the flow hands over to collect_payment', async () => {
    const { s, reply } = await toPayer('pay', 'student', 'uni-2026-0005');
    expect(reply).toEqual({ action: 'navigate', pageId: 'confirm_payer', pageData: { payer_name: 'I*** K***', program_line: 'BSC-NUR · Level 1' } });

    const fees = (await s.step('confirm_payer', 'continue')) as Nav;
    expect(fees.pageId).toBe('select_fee');
    expect(fees.pageData.fees!.map((f) => f.label)).toEqual(['Tuition 2026/27 bal SLE 7,000', 'Matriculation 2026-SEP bal SLE 250']);

    const amountPage = { fee_name: 'Tuition 2026/27', min_display: 'SLE 2,000', max_display: 'SLE 7,000' };
    expect(await s.step('select_fee', fees.pageData.fees![0]!.value)).toEqual({ action: 'navigate', pageId: 'enter_amount', pageData: amountPage });
    expect(await s.step('enter_amount', '1000')).toEqual({ action: 'navigate', pageId: 'try_again', pageData: { message: 'Enter an amount from SLE 2,000 to SLE 7,000.' } });
    expect(await s.step('try_again', 'retry')).toEqual({ action: 'navigate', pageId: 'enter_amount', pageData: amountPage });
    expect(await s.step('enter_amount', '2,500')).toEqual({
      action: 'navigate', pageId: 'confirm_payment', pageData: { payer_name: 'I*** K***', fee_name: 'Tuition 2026/27', amount_display: 'SLE 2,500' },
    });

    const pay = (await s.step('confirm_payment', 'confirm')) as Nav;
    const tuition = await prisma.financialAccount.findUniqueOrThrow({ where: { reference: 'unimak-fee-tuition' } });
    const p = await prisma.payment.findFirstOrThrow({ where: { clientId: 'ussd-flow', idempotencyKey: `${s.id}:confirm_payment` } });
    expect(pay).toEqual({
      action: 'navigate',
      pageId: 'make_payment',
      pageData: {
        amount: '2500', // collect_payment takes major units
        payment_target_ref: tuition.uvan,
        reference: p.id,
        receipt_name: 'Tuition 2026/27',
        payment_id: p.id,
        financial_account_id: tuition.monimeId,
        fee_name: 'Tuition 2026/27',
        amount_display: 'SLE 2,500',
        payment_ref: p.paymentRef,
      },
    });
    expect(p.paymentRef).toMatch(/^[1-9]\d{7}$/);
    // a PENDING hold, no payment code: collection happens inside the USSD session.
    // This subscriber isn't the portal phone, so the paying number is unknown yet.
    expect(p).toMatchObject({ amount: 250_000n, channel: 'USSD', status: 'PENDING', collectionMethod: 'USSD_FLOW', monimeRef: null, payerPhone: null });
    paymentId = p.id;

    // a repeated submit does not create a second payment
    expect(await s.step('confirm_payment', 'confirm')).toMatchObject({ action: 'stop' });
    expect(await prisma.payment.count({ where: { idempotencyKey: { startsWith: s.id } } })).toBe(1);
  });

  it('settles from payment.processing_completed; records the masked paying number and the order number, sends no SMS', async () => {
    const res = await monimeEvent(http, 'payment.processing_completed', { id: 'pay-ussd-1', type: 'payment' }, {
      id: 'pay-ussd-1', status: 'completed', amount: { currency: 'SLE', value: 250000 },
      channel: { type: 'momo', provider: 'm17', phoneNumber: '+23276****56' },
      orderNumber: 'USSD1ORDER01',
      financialAccountId: 'fac-mock-unimak-fee-tuition', reference: paymentId,
      metadata: { payment_id: paymentId, financial_account_id: 'fac-mock-unimak-fee-tuition' },
      fees: [{ code: 'processing', amount: { currency: 'SLE', value: 2500 } }],
    }).expect(200);
    expect(res.body.result).toBe('PROCESSED');
    expect(await prisma.payment.findUnique({ where: { id: paymentId } })).toMatchObject({ status: 'COMPLETED', payerPhone: '+23276****56', monimeOrderNumber: 'USSD1ORDER01' });
    expect(await prisma.outboxMessage.count({ where: { dedupeKey: { contains: paymentId }, type: { startsWith: 'sms' } } })).toBe(0);
  });

  it('checks a payment status by our payment ref or by Monime order number', async () => {
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { receipt: true } });
    const phone = randomUUID(); // its own subscriber: status checks count toward the lookup limit
    const byRef = session(phone);
    expect(await byRef.step('home', 'status')).toEqual({ action: 'navigate', pageId: 'enter_payment_ref', pageData: {} });
    expect(await byRef.step('enter_payment_ref', ` ${p.paymentRef} `)).toEqual({
      action: 'stop',
      message: `Payment ${p.paymentRef}: PAID\nSLE 2,500 Tuition 2026/27\nI*** K*** (UNI-2026-0005)\nReceipt ${p.receipt!.number}`,
    });
    const byOrder = session(phone);
    await byOrder.step('home', 'status');
    expect(await byOrder.step('enter_payment_ref', 'ussd1-order01')).toMatchObject({ action: 'stop', message: expect.stringMatching(new RegExp(`^Payment ${p.paymentRef}: PAID`)) });
    const unknown = session(phone);
    await unknown.step('home', 'status');
    expect(await unknown.step('enter_payment_ref', '99999999')).toEqual({ action: 'navigate', pageId: 'try_again', pageData: { message: 'Payment 99999999 not found.' } });
    expect(await unknown.step('try_again', 'retry')).toEqual({ action: 'navigate', pageId: 'enter_payment_ref', pageData: {} });
  });

  it('knows the paying number when the portal phone dials (subscriberId = uuidv5 of it); metadata wins on completion', async () => {
    const { s } = await toPayer('pay', 'applicant', 'APP-2026-0001', ussdSubscriberIdFor('+23276100001'));
    const fees = (await s.step('confirm_payer', 'continue')) as Nav;
    await s.step('select_fee', fees.pageData.fees![0]!.value);
    const pay = (await s.step('confirm_payment', 'confirm')) as Nav;
    const id = pay.pageData.payment_id as string;
    expect(await prisma.payment.findUnique({ where: { id } })).toMatchObject({ payerPhone: '+23276100001' });
    // Monime reports it masked: the full number we had fits the mask, so it stays
    await monimeEvent(http, 'payment.processing_completed', { id: 'pay-ussd-verified', type: 'payment' }, {
      id: 'pay-ussd-verified', status: 'completed', amount: { currency: 'SLE', value: 15000 }, reference: id,
      channel: { type: 'momo', phoneNumber: '+23276****01' }, metadata: { payment_id: id },
      fees: [{ code: 'processing', amount: { currency: 'SLE', value: 150 } }],
    }).expect(200);
    expect(await prisma.payment.findUnique({ where: { id } })).toMatchObject({ status: 'COMPLETED', payerPhone: '+23276100001' });
  });

  it('cancel at confirmation shows the cancelled page and creates nothing', async () => {
    const { s } = await toPayer('pay', 'applicant', 'APP-2026-0002');
    const fees = (await s.step('confirm_payer', 'continue')) as Nav;
    expect(await s.step('select_fee', fees.pageData.fees![0]!.value)).toMatchObject({ pageId: 'confirm_payment', pageData: { amount_display: 'SLE 150' } });
    expect(await s.step('confirm_payment', 'cancel')).toEqual({ action: 'navigate', pageId: 'payment_cancelled', pageData: {} });
    expect(await prisma.payment.count({ where: { idempotencyKey: { startsWith: s.id } } })).toBe(0);
  });

  it('collection never fails once at Monime: a late completion after expiry is still applied (overpayment flagged)', async () => {
    async function startAppFee(): Promise<string> {
      const { s } = await toPayer('pay', 'applicant', 'APP-2026-0002');
      const fees = (await s.step('confirm_payer', 'continue')) as Nav;
      await s.step('select_fee', fees.pageData.fees![0]!.value);
      const pay = (await s.step('confirm_payment', 'confirm')) as Nav;
      return pay.pageData.payment_id as string;
    }
    const complete = (id: string, monimeId: string) =>
      monimeEvent(http, 'payment.processing_completed', { id: monimeId, type: 'payment' }, {
        id: monimeId, status: 'completed', amount: { currency: 'SLE', value: 15000 }, reference: id, metadata: { payment_id: id },
        fees: [{ code: 'processing', amount: { currency: 'SLE', value: 150 } }], // USSD 1%
      }).expect(200);

    const first = await startAppFee();
    // the payer took longer than 15 min to approve: the hold lapses…
    await prisma.payment.update({ where: { id: first }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http.get('/cron/expire-payments').set('authorization', `Bearer ${process.env.CRON_SECRET}`).expect(200);
    // …someone pays again and it completes
    const second = await startAppFee();
    expect((await complete(second, 'pay-app-2')).body.result).toBe('PROCESSED');
    // then the first one completes after all: money moved, so it is applied
    const late = await complete(first, 'pay-app-1');
    expect(late.body).toMatchObject({ result: 'PROCESSED', note: 'Late settlement: payment was EXPIRED; Overpaid by 15000 (obligation balance below zero)' });
    expect(await prisma.payment.findUnique({ where: { id: first } })).toMatchObject({ status: 'COMPLETED' });
  });
});
