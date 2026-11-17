import { Logger } from '@nestjs/common';
import type { SmsSender } from './sms.port';

/** Logs instead of sending. Keeps the last messages for tests/inspection. */
export class ConsoleSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');
  readonly sent: { phone: string; text: string; at: Date }[] = [];

  async send(phone: string, text: string): Promise<void> {
    this.sent.push({ phone, text, at: new Date() });
    if (this.sent.length > 500) this.sent.shift();
    this.logger.log(`→ ${phone}: ${text}`);
  }
}
