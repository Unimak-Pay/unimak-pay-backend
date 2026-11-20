import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';
import { parse } from 'yaml';
import { createApp } from '../../src/bootstrap';
import { EXPORT_MAX_ROWS } from '../../src/modules/admin-api/application/payments-csv';
import { ProvisionAccountsUseCase } from '../../src/modules/treasury/application/provision-accounts.use-case';
import { adminToken, channel, monimeEvent } from './helpers';

/**
 * Contract test: every admin operation in openapi.yaml is called, and each
 * response must (1) validate against the documented schema and (2) contain no
 * property the spec doesn't document. So the dashboard can trust the spec.
 */

type Json = Record<string, unknown>;
const spec = parse(readFileSync(path.resolve('openapi.yaml'), 'utf8')) as Json;

// Refs inside extracted schemas must resolve against the whole document.
const SPEC_ID = 'https://unimak.test/openapi';
const rewrite = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(rewrite)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === '$ref' && typeof x === 'string' && x.startsWith('#') ? `${SPEC_ID}${x}` : rewrite(x)]))
      : v;
const doc = rewrite(spec) as Json;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: SPEC_ID });

function pointer(ref: string): Json {
  const ptr = ref.replace(SPEC_ID, '').replace(/^#\//, '');
  return ptr.split('/').reduce<Json>((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')] as Json, doc);
}
const deref = (s: Json): Json => (typeof s?.['$ref'] === 'string' ? deref(pointer(s['$ref'] as string)) : s);

const compiled = new Map<string, ValidateFunction>();
function responseSchema(method: string, route: string, status: number): Json {
  const op = ((doc['paths'] as Json)[route] as Json | undefined)?.[method] as Json | undefined;
  if (!op) throw new Error(`${method.toUpperCase()} ${route} is not in openapi.yaml`);
  const res = (op['responses'] as Json)[String(status)] as Json | undefined;
  if (!res) throw new Error(`${method.toUpperCase()} ${route} has no documented ${status} response`);
  const schema = ((deref(res)['content'] as Json)['application/json'] as Json)['schema'] as Json;
  return schema;
}

/** Properties present in `value` that `schema` doesn't document (open schemas allow anything). */
function undocumented(value: unknown, schema: Json, at: string): string[] {
  const s = deref(schema);
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return s['items'] ? value.flatMap((v, i) => undocumented(v, s['items'] as Json, `${at}[${i}]`)) : [];
  if (typeof value !== 'object') return [];
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (s[k]) {
      const branch = (s[k] as Json[]).find((b) => ajv.validate({ ...b }, value));
      return branch ? undocumented(value, branch, at) : [];
    }
  }
  const props: Record<string, Json> = {};
  let open = false;
  const collect = (x: Json) => {
    const r = deref(x);
    if (r['allOf']) (r['allOf'] as Json[]).forEach(collect);
    if (r['properties']) Object.assign(props, r['properties']);
    if (!r['properties'] && !r['allOf']) open = true; // e.g. JSON columns
    if (r['additionalProperties'] !== undefined && r['additionalProperties'] !== false) open = true;
  };
  collect(s);
  return Object.entries(value as Json).flatMap(([k, v]) =>
    props[k] ? undocumented(v, props[k], `${at}.${k}`) : open ? [] : [`${at}.${k}`]);
}

const checked = new Set<string>();
/** Asserts the response matches the spec; returns the body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function conforms(method: string, route: string, res: request.Response): Record<string, any> {
  const key = `${method.toUpperCase()} ${route}`;
  const schema = responseSchema(method, route, res.status);
  const id = `${key} ${res.status}`;
  let validate = compiled.get(id);
  if (!validate) compiled.set(id, (validate = ajv.compile(schema)));
  const ok = validate(res.body);
  const extra = undocumented(res.body, schema, '$');
  if (!ok || extra.length) {
    throw new Error(`${id} does not match openapi.yaml:\n${JSON.stringify({ errors: validate.errors?.slice(0, 8), undocumented: extra.slice(0, 20) }, null, 2)}`);
  }
  checked.add(key);
  return res.body as Json;
}

let app: INestApplication;
let http: ReturnType<typeof request>;
const prisma = new PrismaClient();
let token: string;
const as = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
  const r = http[method](url).set('authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};

async function payTuition(amount: string, key: string, simulate: Json = {}): Promise<string> {
  const ob = await channel(http, 'get', '/v1/channel/payers/student/UNI-2024-0007/obligations').expect(200);
  const o = ob.body.obligations.find((x: { feeTypeCode: string }) => x.feeTypeCode === 'TUITION');
  const res = await channel(http, 'post', '/v1/channel/payments', { obligationId: o.id, amount, payerPhone: '+23234200007', channel: 'DOTS', idempotencyKey: key }).expect(201);
  if (simulate !== null) await http.post('/dev/monime/simulate-webhook').send({ paymentId: res.body.paymentId, outcome: 'completed', ...simulate }).expect(200);
  return res.body.paymentId;
}

beforeAll(async () => {
  app = await createApp();
  http = request(app.getHttpServer());
  await app.get(ProvisionAccountsUseCase).execute();
  const email = `contract-${randomUUID().slice(0, 8)}@unimak.test`;
  await prisma.adminUser.create({ data: { email, role: 'SUPER_ADMIN' } });
  token = adminToken({ sub: randomUUID(), email, aal: 'aal2' });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('admin API responses match openapi.yaml', () => {
  let paymentId: string;
  let transferId: string;

  it('me, users, audit', async () => {
    conforms('get', '/v1/admin/me', await as('get', '/v1/admin/me').expect(200));
    const created = conforms('post', '/v1/admin/users', await as('post', '/v1/admin/users', { email: `fo-${randomUUID().slice(0, 6)}@unimak.test`, role: 'FINANCE_OFFICER', name: 'FO' }).expect(201));
    conforms('get', '/v1/admin/users', await as('get', '/v1/admin/users').expect(200));
    conforms('get', '/v1/admin/users/{id}', await as('get', `/v1/admin/users/${created.id}`).expect(200));
    conforms('post', '/v1/admin/users/{id}/invite', await as('post', `/v1/admin/users/${created.id}/invite`).expect(200));
    conforms('patch', '/v1/admin/users/{id}', await as('patch', `/v1/admin/users/${created.id}`, { active: false }).expect(200));
    conforms('get', '/v1/admin/audit-log', await as('get', '/v1/admin/audit-log?limit=5').expect(200));
  });

  it('faculties and departments', async () => {
    conforms('get', '/v1/admin/faculties', await as('get', '/v1/admin/faculties').expect(200));
    const code = `FAC-C${randomUUID().slice(0, 4)}`;
    conforms('post', '/v1/admin/faculties', await as('post', '/v1/admin/faculties', { code, name: 'Contract faculty' }).expect(201));
    const dept = `D-C${randomUUID().slice(0, 4)}`;
    conforms('post', '/v1/admin/departments', await as('post', '/v1/admin/departments', { code: dept, name: 'Contract dept', facultyCode: code }).expect(201));
    conforms('get', '/v1/admin/departments', await as('get', '/v1/admin/departments?active=true').expect(200));
    conforms('get', '/v1/admin/departments/{code}', await as('get', `/v1/admin/departments/${dept}`).expect(200));
    conforms('patch', '/v1/admin/departments/{code}', await as('patch', `/v1/admin/departments/${dept}`, { active: false }).expect(200));
    conforms('patch', '/v1/admin/faculties/{code}', await as('patch', `/v1/admin/faculties/${code}`, { name: 'Renamed', active: false }).expect(200));
    const dean = conforms('post', '/v1/admin/users', await as('post', '/v1/admin/users', { email: `dean-${randomUUID().slice(0, 6)}@unimak.test`, role: 'DEAN', faculties: ['FAC-NURSING-AHS'] }).expect(201));
    expect(dean.faculties).toEqual(['FAC-NURSING-AHS']);
  });

  it('payments, reports, export', async () => {
    paymentId = await payTuition('200000', 'contract-1');
    const list = conforms('get', '/v1/admin/payments', await as('get', '/v1/admin/payments?limit=3&sort=-amount').expect(200));
    expect((list.items as unknown[]).length).toBeGreaterThan(0);
    const detail = conforms('get', '/v1/admin/payments/{id}', await as('get', `/v1/admin/payments/${paymentId}`).expect(200));
    expect(detail.ledgerEntry).not.toBeNull();
    transferId = (detail.commissionTransfer as Json).id as string;
    conforms('post', '/v1/admin/payments/{id}/reconcile', await as('post', `/v1/admin/payments/${paymentId}/reconcile`).expect(200));
    conforms('get', '/v1/admin/reports/summary', await as('get', '/v1/admin/reports/summary').expect(200));

    const csv = await as('get', '/v1/admin/payments/export.csv?payerRef=UNI-2024-0007').expect(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="unimak-payments-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = csv.text.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('created_at,completed_at,payment_ref,status,channel,collection_method,fee_type,fee_name,payer_kind,payer_ref,payer_name,program,department,department_name,faculty,faculty_name,amount_sle,monime_fee_sle,platform_fee_sle,net_sle,payer_phone,monime_order_number,monime_payment_id,receipt_number,failure_reason,payment_id');
    expect(lines.find((l) => l.endsWith(paymentId))).toMatch(/,COMPLETED,DOTS,PAYMENT_CODE,TUITION,Tuition 2026\/27,STUDENT,UNI-2024-0007,Ama Owusu,BSC-NUR,NURSING,Nursing,FAC-NURSING-AHS,Faculty of Nursing and Allied Health Sciences,2000\.00,/);
    checked.add('GET /v1/admin/payments/export.csv');
  });

  it('fee setup', async () => {
    const code = `C${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    const ft = conforms('post', '/v1/admin/fee-types', await as('post', '/v1/admin/fee-types', { code, name: 'Contract fee', payerKind: 'STUDENT', recurrence: 'ONCE' }).expect(201));
    conforms('get', '/v1/admin/fee-types', await as('get', '/v1/admin/fee-types').expect(200));
    conforms('patch', '/v1/admin/fee-types/{id}', await as('patch', `/v1/admin/fee-types/${ft.id}`, { name: 'Contract fee 2' }).expect(200));
    conforms('post', '/v1/admin/fee-types/{id}/account', await as('post', `/v1/admin/fee-types/${ft.id}/account`).expect(200));
    const fee = conforms('post', '/v1/admin/fees', await as('post', '/v1/admin/fees', { feeTypeId: ft.id, name: 'Contract 2026/27', period: '2026/27', allowInstalments: true, defaultMinInstalment: '1000', dueDate: '2027-01-31' }).expect(201));
    expect(fee.dueDate).toBe('2027-01-31');
    const rule = conforms('post', '/v1/admin/fees/{id}/rate-rules', await as('post', `/v1/admin/fees/${fee.id}/rate-rules`, { amount: '5000' }).expect(201));
    conforms('put', '/v1/admin/fees/{id}/rate-rules/{ruleId}', await as('put', `/v1/admin/fees/${fee.id}/rate-rules/${rule.id}`, { amount: '6000' }).expect(200));
    const el = conforms('post', '/v1/admin/fees/{id}/eligibility-rules', await as('post', `/v1/admin/fees/${fee.id}/eligibility-rules`, { department: 'NURSING' }).expect(201));
    conforms('put', '/v1/admin/fees/{id}/instalment-rules/{department}', await as('put', `/v1/admin/fees/${fee.id}/instalment-rules/NURSING`, { minInstalment: '2000' }).expect(200));
    conforms('patch', '/v1/admin/fees/{id}', await as('patch', `/v1/admin/fees/${fee.id}`, { status: 'ACTIVE' }).expect(200));
    conforms('get', '/v1/admin/fees', await as('get', '/v1/admin/fees').expect(200));
    conforms('get', '/v1/admin/fees/{id}', await as('get', `/v1/admin/fees/${fee.id}`).expect(200));
    conforms('get', '/v1/admin/fees/{id}/preview', await as('get', `/v1/admin/fees/${fee.id}/preview?kind=student&ref=UNI-2024-0007`).expect(200));
    conforms('delete', '/v1/admin/fees/{id}/instalment-rules/{department}', await as('delete', `/v1/admin/fees/${fee.id}/instalment-rules/NURSING`).expect(200));
    conforms('delete', '/v1/admin/fees/{id}/eligibility-rules/{ruleId}', await as('delete', `/v1/admin/fees/${fee.id}/eligibility-rules/${el.id}`).expect(200));
    // the last rate rule can go once the fee is back to draft
    await as('patch', `/v1/admin/fees/${fee.id}`, { status: 'CLOSED' }).expect(200);
    conforms('delete', '/v1/admin/fees/{id}/rate-rules/{ruleId}', await as('delete', `/v1/admin/fees/${fee.id}/rate-rules/${rule.id}`).expect(200));
  });

  it('treasury: accounts, banks, payouts, transfers, outbox', async () => {
    conforms('post', '/v1/admin/financial-accounts/provision', await as('post', '/v1/admin/financial-accounts/provision').expect(200));
    const accounts = conforms('get', '/v1/admin/financial-accounts', await as('get', '/v1/admin/financial-accounts').expect(200)) as unknown as Json[];
    const tuition = accounts.find((a) => a.reference === 'unimak-fee-tuition')!;
    conforms('post', '/v1/admin/financial-accounts/{id}/refresh-balance', await as('post', `/v1/admin/financial-accounts/${tuition.id}/refresh-balance`).expect(200));
    conforms('get', '/v1/admin/banks', await as('get', '/v1/admin/banks').expect(200));
    const payout = conforms('post', '/v1/admin/payouts', await as('post', '/v1/admin/payouts', { account: 'unimak-fee-tuition', amount: '1000', bankProviderId: 'slb001', accountNumber: '0011223344', accountName: 'UNIMAK', idempotencyKey: `contract-payout-${randomUUID()}` }).expect(201));
    conforms('get', '/v1/admin/payouts', await as('get', '/v1/admin/payouts?status=SUBMITTED&sort=amount').expect(200));
    conforms('get', '/v1/admin/payouts/{id}', await as('get', `/v1/admin/payouts/${payout.id}`).expect(200));

    await http.post('/dev/monime/simulate-webhook').send({ transferId, outcome: 'failed' }).expect(200);
    conforms('get', '/v1/admin/transfers', await as('get', '/v1/admin/transfers?status=FAILED&sort=-amount').expect(200));
    conforms('get', '/v1/admin/transfers/{id}', await as('get', `/v1/admin/transfers/${transferId}`).expect(200));
    conforms('post', '/v1/admin/transfers/{id}/retry', await as('post', `/v1/admin/transfers/${transferId}/retry`).expect(200));

    const msg = await prisma.outboxMessage.findFirstOrThrow({ where: { dedupeKey: `monime.commission_transfer:${paymentId}` } });
    await prisma.outboxMessage.update({ where: { id: msg.id }, data: { status: 'DEAD' } });
    conforms('get', '/v1/admin/outbox', await as('get', '/v1/admin/outbox?status=DEAD').expect(200));
    conforms('get', '/v1/admin/outbox/{id}', await as('get', `/v1/admin/outbox/${msg.id}`).expect(200));
    conforms('post', '/v1/admin/outbox/{id}/retry', await as('post', `/v1/admin/outbox/${msg.id}/retry`).expect(200));
  });

  it('reconciliation: summary, runs, items, webhook events', async () => {
    // an UNMATCHED event (amount mismatch) and a FAILED one
    await payTuition('210000', 'contract-2', { amount: '209999' });
    const failedId = `wke-contract-${randomUUID()}`;
    await monimeEvent(http, 'payment.processing_completed', { id: 'spm-x', type: 'payment' }, { id: 'spm-x', status: 'completed', amount: { currency: 'SLE', value: 100 } }, failedId).expect(200);
    await prisma.webhookEvent.update({ where: { id: failedId }, data: { status: 'FAILED', error: 'simulated' } });

    const summary = conforms('get', '/v1/admin/reconciliation', await as('get', '/v1/admin/reconciliation').expect(200));
    const run = conforms('post', '/v1/admin/reconciliation/runs', await as('post', '/v1/admin/reconciliation/runs', { date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) }).expect(201));
    conforms('get', '/v1/admin/reconciliation/runs', await as('get', '/v1/admin/reconciliation/runs?status=COMPLETED').expect(200));
    conforms('get', '/v1/admin/reconciliation/runs/{id}', await as('get', `/v1/admin/reconciliation/runs/${run.id}`).expect(200));

    let item = await prisma.reconciliationItem.findFirst({ where: { status: 'OPEN' } });
    item ??= await prisma.reconciliationItem.create({ data: { runId: run.id as string, kind: 'CONTRACT', note: 'contract test' } });
    conforms('get', '/v1/admin/reconciliation/items', await as('get', '/v1/admin/reconciliation/items?status=OPEN').expect(200));
    conforms('post', '/v1/admin/reconciliation/items/{id}/resolve', await as('post', `/v1/admin/reconciliation/items/${item.id}/resolve`, { resolution: 'checked by the contract test' }).expect(200));

    const events = conforms('get', '/v1/admin/reconciliation/webhook-events', await as('get', '/v1/admin/reconciliation/webhook-events?status=UNMATCHED&unresolved=true').expect(200));
    const unmatched = (events.items as Json[])[0]!;
    expect((summary.counts as Json).webhookEvents).toBeGreaterThan(0);
    conforms('get', '/v1/admin/reconciliation/webhook-events/{id}', await as('get', `/v1/admin/reconciliation/webhook-events/${unmatched.id}`).expect(200));
    conforms('post', '/v1/admin/reconciliation/webhook-events/{id}/resolve', await as('post', `/v1/admin/reconciliation/webhook-events/${unmatched.id}/resolve`, { resolution: 'contract' }).expect(200));
    conforms('post', '/v1/admin/reconciliation/webhook-events/{id}/replay', await as('post', `/v1/admin/reconciliation/webhook-events/${failedId}/replay`).expect(200));
  });

  it('sorting, typed filters and cursors behave', async () => {
    const amounts = async (url: string) => ((await as('get', url).expect(200)).body.items as { amount: string }[]).map((x) => BigInt(x.amount));
    const desc = await amounts('/v1/admin/payments?limit=50&sort=-amount');
    expect(desc).toEqual([...desc].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    const asc = await amounts('/v1/admin/transfers?limit=50&sort=amount');
    expect(asc).toEqual([...asc].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // cursor paging under a non-default sort visits every row exactly once
    const all: string[] = [];
    for (let cursor: string | null = null, n = 0; n < 50; n++) {
      const res: request.Response = await as('get', `/v1/admin/payments?limit=2&sort=amount${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      all.push(...(res.body.items as { id: string }[]).map((x) => x.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(await prisma.payment.count());

    await as('get', '/v1/admin/payouts?status=DONE').expect(400); // enums are validated
    const runs = (await as('get', '/v1/admin/reconciliation/runs?status=FAILED').expect(200)).body.items as { status: string }[];
    expect(runs.every((r) => r.status === 'FAILED')).toBe(true);
    const events = (await as('get', '/v1/admin/reconciliation/webhook-events?limit=1').expect(200)).body;
    if (events.nextCursor) await as('get', `/v1/admin/reconciliation/webhook-events?limit=1&cursor=${encodeURIComponent(events.nextCursor)}`).expect(200);

    // summary counts are exact, not list lengths
    const summary = (await as('get', '/v1/admin/reconciliation').expect(200)).body;
    expect(summary.counts.deadOutbox).toBe(await prisma.outboxMessage.count({ where: { status: 'DEAD' } }));
    expect(summary.listLimit).toBe(100);
  });

  it('CSV export needs payments.export and is audited', async () => {
    expect(EXPORT_MAX_ROWS).toBe(50_000);
    const fo = `fo-${randomUUID().slice(0, 6)}@unimak.test`;
    await prisma.adminUser.create({ data: { email: fo, role: 'FINANCE_OFFICER' } });
    const foToken = adminToken({ sub: randomUUID(), email: fo, aal: 'aal1' });
    await http.get('/v1/admin/payments/export.csv').set('authorization', `Bearer ${foToken}`).expect(200); // payments.export
    const hod = `hod-${randomUUID().slice(0, 6)}@unimak.test`;
    await prisma.adminUser.create({ data: { email: hod, role: 'HEAD_OF_DEPARTMENT', departments: ['NURSING'] } });
    const hodToken = adminToken({ sub: randomUUID(), email: hod });
    await http.get('/v1/admin/payments/export.csv').set('authorization', `Bearer ${hodToken}`).expect(403); // no payments.export
    expect(await prisma.auditLog.count({ where: { action: 'payments.export' } })).toBeGreaterThan(0);
  });

  it('covered every admin operation in the spec', () => {
    const ops = Object.entries(spec['paths'] as Json)
      .filter(([p]) => p.startsWith('/v1/admin/'))
      .flatMap(([p, item]) => Object.keys(item as Json).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${p}`));
    expect(ops.filter((o) => !checked.has(o)).sort()).toEqual([]);
  });
});
