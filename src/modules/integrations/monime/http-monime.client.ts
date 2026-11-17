import {
  type InitiateCollectionInput,
  type InitiateCollectionResult,
  type MonimeClient,
  MonimeError,
  type MonimePaymentView,
  type TransferInput,
  type TransferResult,
} from './monime.port';

const TIMEOUT_MS = 10_000;

/**
 * Real Monime adapter. Nothing below is confirmed against Monime's API docs —
 * every wire-format detail is marked TODO(monime) for you to fill in.
 */
export class HttpMonimeClient implements MonimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly spaceId: string | undefined,
  ) {}

  async initiateCollection(input: InitiateCollectionInput): Promise<InitiateCollectionResult> {
    // TODO(monime): endpoint for creating a USSD / Dots collection (payment code? checkout?).
    // TODO(monime): request body field names; how amount is expressed (minor units? currency object?).
    // TODO(monime): how the destination/settlement financial account is specified.
    // TODO(monime): does Monime take our expiry, or impose its own?
    const body = await this.request('POST', '/TODO-monime-collections', input.reference, {
      reference: input.reference,
      amount: { currency: input.currency, value: input.amount.toString() },
      payerPhone: input.payerPhone,
      channel: input.channel,
      financialAccountId: input.settlementAccount,
      description: input.description,
      expiresAt: input.expiresAt.toISOString(),
      metadata: input.metadata,
    });
    // TODO(monime): response field names for the collection id and status.
    return { monimeRef: String(body['id']), status: 'PENDING' };
  }

  async getPayment(monimeRef: string): Promise<MonimePaymentView> {
    // TODO(monime): endpoint + response mapping for fetching a payment/collection.
    const body = await this.request('GET', `/TODO-monime-payments/${encodeURIComponent(monimeRef)}`);
    return {
      monimeRef,
      reference: typeof body['reference'] === 'string' ? body['reference'] : null,
      status: mapStatus(body['status']),
      amount: BigInt(String(body['amount'] ?? '0')), // TODO(monime): amount shape
    };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    // TODO(monime): internal transfer endpoint between financial accounts and its body shape.
    const body = await this.request('POST', '/TODO-monime-transfers', input.idempotencyKey, {
      sourceFinancialAccountId: input.fromAccount,
      destinationFinancialAccountId: input.toAccount,
      amount: { currency: input.currency, value: input.amount.toString() },
      description: input.description,
    });
    return { transferId: String(body['id']), status: 'PENDING' };
  }

  private async request(
    method: string,
    path: string,
    idempotencyKey?: string,
    payload?: unknown,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(new URL(path.replace(/^\//, ''), this.baseUrl.replace(/\/?$/, '/')), {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`, // TODO(monime): auth scheme
          ...(this.spaceId ? { 'Monime-Space-Id': this.spaceId } : {}), // TODO(monime): header name
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), // TODO(monime): header name
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new MonimeError('UNAVAILABLE', `Monime request failed: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new MonimeError('NOT_FOUND', `Not found: ${path}`, 404);
    if (res.status >= 400 && res.status < 500) {
      throw new MonimeError('REJECTED', `Monime rejected request (${res.status})`, res.status);
    }
    if (!res.ok) throw new MonimeError('UNAVAILABLE', `Monime returned ${res.status}`, res.status);
    try {
      // TODO(monime): is the payload wrapped (e.g. { result: {...} })?
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new MonimeError('BAD_RESPONSE', 'Monime returned invalid JSON', res.status);
    }
  }
}

function mapStatus(raw: unknown): MonimePaymentView['status'] {
  // TODO(monime): actual status vocabulary.
  switch (String(raw).toLowerCase()) {
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'expired':
      return 'EXPIRED';
    default:
      return 'PENDING';
  }
}
