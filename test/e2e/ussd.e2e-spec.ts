import { createPublicKey, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { decryptReply, encryptAsMonime } from '../../src/modules/ussd/domain/exchange-crypto';
import { uuidv5Url } from '../../src/modules/ussd/domain/subscriber-id';

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();
const URL = `/v1/ussd/exchange/${process.env.USSD_EXCHANGE_PATH_TOKEN}`;
const PHONE = '+23276123456';
const SUBSCRIBER = uuidv5Url(PHONE); // as Monime derives global.subscriberId

type Reply = { action: 'navigate'; pageId: string; pageData: { message?: string; items?: { value: string; label: string }[] } } | { action: 'stop'; message: string };

/** One exchange call, encrypted exactly like Monime does it. */
async function exchange(session: string, currentPage: string, flowData: Record<string, string> = {}, opts: { exportedData?: Record<string, string>; subscriberId?: string; previousKey?: boolean } = {}): Promise<Reply> {
  const pub = createPublicKey(opts.previousKey ? process.env.E2E_USSD_PREVIOUS_PUBLIC_KEY! : process.env.E2E_USSD_PUBLIC_KEY!);
  const payload = {
    global: { sessionId: session, networkName: 'Orange', subscriberId: opts.subscriberId ?? SUBSCRIBER, subscriberMsisdn: '+23276****56', networkProviderName: 'Orange Money' },
    currentPage, flowData, ...(opts.exportedData ? { exportedData: opts.exportedData } : {}),
  };
  const { body, aesKey } = encryptAsMonime(payload, pub);
  const res = await http.post(URL).set('content-type', 'application/json').send(body).expect(200);
  expect(res.headers['content-type']).toMatch(/^text\/plain/);
  return decryptReply(res.text, aesKey) as Reply;
}

/** Walks start → … → enter_id; returns the session id and the reply after enter_id. */
async function toPayer(intent: string, kind: string, ref: string, subscriberId = SUBSCRIBER) {
  const s = `sess-${randomUUID()}`;
  const flow: Record<string, string> = {};
  expect((await exchange(s, 'start', flow, { subscriberId })).action).toBe('navigate');
  Object.assign(flow, { main_menu: intent });
  await exchange(s, 'main_menu', flow, { subscriberId });
  Object.assign(flow, { id_type: kind });
  await exchange(s, 'id_type', flow, { subscriberId });
  Object.assign(flow, { enter_id: ref });
  return { s, flow, reply: await exchange(s, 'enter_id', flow, { subscriberId }) };
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
    await http.post(URL).send({ global: { sessionId: 'x', subscriberId: 'y' }, currentPage: 'start', flowData: {} }).expect(400);
    const { body } = encryptAsMonime({ currentPage: 'start' }, createPublicKey(process.env.E2E_USSD_PUBLIC_KEY!));
    const blob = Buffer.from(body.encryptedExchangeData, 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    const res = await http.post(URL).send({ ...body, encryptedExchangeData: blob.toString('base64') }).expect(400);
    expect(res.body).toEqual({ action: 'stop', message: 'Decryption failed' });
  });

  it('accepts the previous key during rotation', async () => {
    const r = await exchange(`sess-${randomUUID()}`, 'start', {}, { previousKey: true });
    expect(r).toMatchObject({ action: 'navigate', pageId: 'main_menu' });
  });

  it('ignores flowData that skips ahead (server-side session state)', async () => {
    const s = `sess-${randomUUID()}`;
    await exchange(s, 'start');
    expect(await exchange(s, 'confirm_amount', { confirm_amount: 'yes' })).toEqual({ action: 'stop', message: 'Session expired. Please dial again.' });
    // and a session id replayed from another subscriber
    const t = `sess-${randomUUID()}`;
    await exchange(t, 'start');
    expect(await exchange(t, 'main_menu', { main_menu: 'pay' }, { subscriberId: uuidv5Url('+23277000000') })).toMatchObject({ action: 'stop' });
  });

  it('rate-limits ID lookups per subscriber', async () => {
    const sub = uuidv5Url('+23299111111');
    for (let i = 0; i < 4; i++) {
      // each session: 1 hit + 2 retries = 3 lookups
      const { s, flow } = await toPayer('balance', 'student', 'NOPE-1', sub);
      await exchange(s, 'enter_id', { ...flow, enter_id: 'NOPE-2' }, { subscriberId: sub });
      const last = await exchange(s, 'enter_id', { ...flow, enter_id: 'NOPE-3' }, { subscriberId: sub });
      if (i < 3) expect(last).toEqual({ action: 'stop', message: 'ID not found. Please check the number and try again.' });
      else expect(last).toEqual({ action: 'stop', message: 'Too many lookups. Please try again later.' });
    }
  });
});

describe('USSD menus', () => {
  it('help ends the session with the finance office number', async () => {
    const s = `sess-${randomUUID()}`;
    const menu = await exchange(s, 'start');
    expect(menu).toMatchObject({ pageId: 'main_menu', pageData: { items: expect.arrayContaining([{ value: 'help', label: 'Help' }]) } });
    expect(await exchange(s, 'main_menu', { main_menu: 'help' })).toMatchObject({ action: 'stop', message: expect.stringMatching(/Finance Office/) });
  });

  it('wrong ID: two retries, then the session ends', async () => {
    const { s, flow, reply } = await toPayer('pay', 'student', 'UNI-0000');
    expect(reply).toMatchObject({ action: 'navigate', pageId: 'enter_id', pageData: { message: 'ID not found. Enter it again (2 left)' } });
    expect(await exchange(s, 'enter_id', { ...flow, enter_id: 'UNI-0001' })).toMatchObject({ pageData: { message: 'ID not found. Enter it again (1 left)' } });
    expect(await exchange(s, 'enter_id', { ...flow, enter_id: 'UNI-0002' })).toMatchObject({ action: 'stop' });
  });

  it('check balance lists fees with balances', async () => {
    const { reply } = await toPayer('balance', 'student', 'uni-2025-0003');
    expect(reply).toMatchObject({ action: 'stop', message: expect.stringMatching(/^C\*\*\* O\*\*\*\nTuition 2026\/27: SLE /) });
  });
});

describe('USSD payment journey', () => {
  let paymentId: string;

  it('student pays a tuition instalment and shares their number', async () => {
    const { s, flow, reply } = await toPayer('pay', 'student', 'uni-2026-0005');
    expect(reply).toMatchObject({ action: 'navigate', pageId: 'confirm_payer', pageData: { message: 'I*** K*** - BSC-NUR · Level 1' } });

    flow.confirm_payer = 'yes';
    const fees = await exchange(s, 'confirm_payer', flow);
    expect(fees).toMatchObject({ pageId: 'select_fee' });
    const items = (fees as Extract<Reply, { action: 'navigate' }>).pageData.items!;
    expect(items.map((i) => i.label)).toEqual(['Tuition 2026/27 bal SLE 7,000', 'Matriculation 2026-SEP bal SLE 250']);

    flow.select_fee = items[0]!.value;
    expect(await exchange(s, 'select_fee', flow)).toMatchObject({ pageId: 'enter_amount', pageData: { message: 'Enter amount (min SLE 2,000, max SLE 7,000)' } });
    flow.enter_amount = '1000';
    expect(await exchange(s, 'enter_amount', flow)).toMatchObject({ pageId: 'enter_amount', pageData: { message: 'Enter SLE 2,000 to SLE 7,000' } });
    flow.enter_amount = '2500';
    expect(await exchange(s, 'enter_amount', flow)).toMatchObject({ pageId: 'confirm_amount', pageData: { message: 'Pay SLE 2,500?' } });
    flow.confirm_amount = 'yes';
    expect(await exchange(s, 'confirm_amount', flow)).toEqual({ action: 'navigate', pageId: 'share_number', pageData: {} });

    flow.share_number = PHONE;
    const done = await exchange(s, 'share_number', flow, { exportedData: { phone_number: PHONE } });
    expect(done).toMatchObject({ action: 'stop', message: expect.stringMatching(/^Dial \*715\*1\*\d+# to pay SLE 2,500\. Valid 1[45] min\. Receipt by SMS\.$/) });

    const p = await prisma.payment.findFirstOrThrow({ where: { clientId: 'ussd-flow', idempotencyKey: `${s}:share_number` } });
    expect(p).toMatchObject({ amount: 250_000n, channel: 'USSD', payerPhone: PHONE, phoneAuthorized: true, status: 'PENDING' });
    const code = await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: p.monimeRef! } });
    expect((code.data as Record<string, unknown>)['authorizedPhoneNumber']).toBe(PHONE);
    paymentId = p.id;

    // a repeated submit of the last step does not create a second payment
    expect((await exchange(s, 'share_number', flow, { exportedData: { phone_number: PHONE } })).action).toBe('stop');
    expect(await prisma.payment.count({ where: { idempotencyKey: { startsWith: s } } })).toBe(1);
  });

  it('receipt SMS goes to the paying phone and to the phone on the portal record', async () => {
    await http.post('/dev/monime/simulate-webhook').send({ paymentId, outcome: 'completed' }).expect(200);
    const sms = await prisma.outboxMessage.findMany({ where: { dedupeKey: { startsWith: `sms.receipt:${paymentId}` } } });
    expect(sms.map((m) => (m.payload as { phone: string }).phone).sort()).toEqual([PHONE, '+23230200005'].sort());
  });

  it('resend last receipt', async () => {
    const { reply } = await toPayer('resend', 'student', 'UNI-2026-0005');
    expect(reply).toMatchObject({ action: 'stop', message: expect.stringMatching(/^Receipt UNIMAK-\d{4}-\d{6} sent by SMS\.$/) });
  });

  it('a parent paying the application fee without sharing their number gets an open code', async () => {
    const { s, flow } = await toPayer('pay', 'applicant', 'APP-2026-0002');
    flow.confirm_payer = 'yes';
    const fees = (await exchange(s, 'confirm_payer', flow)) as Extract<Reply, { action: 'navigate' }>;
    flow.select_fee = fees.pageData.items![0]!.value;
    expect(await exchange(s, 'select_fee', flow)).toMatchObject({ pageId: 'confirm_amount', pageData: { message: 'Pay SLE 150 for Application fee 2026-SEP?' } });
    flow.confirm_amount = 'yes';
    await exchange(s, 'confirm_amount', flow);
    // a number that doesn't hash to this subscriber is ignored (tampered exportedData)
    const done = await exchange(s, 'share_number', flow, { exportedData: { phone_number: '+23277999999' } });
    expect(done).toMatchObject({ action: 'stop', message: expect.stringMatching(/^Dial /) });
    const p = await prisma.payment.findFirstOrThrow({ where: { idempotencyKey: `${s}:share_number` } });
    expect(p).toMatchObject({ phoneAuthorized: false, payerPhone: '+23277100002' });
    const code = await prisma.mockMonimeRecord.findUniqueOrThrow({ where: { id: p.monimeRef! } });
    expect((code.data as Record<string, unknown>)['authorizedPhoneNumber']).toBeNull();
  });
});
