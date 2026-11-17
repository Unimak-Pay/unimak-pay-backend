import type { OutboxPayloads, OutboxType } from '../domain/messages';

export const OUTBOX_HANDLERS = Symbol('OutboxHandlers');

export interface OutboxHandler<K extends OutboxType = OutboxType> {
  readonly type: K;
  /** Must be idempotent: a message can be delivered more than once. */
  handle(payload: OutboxPayloads[K]): Promise<void>;
}
