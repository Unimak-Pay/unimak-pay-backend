import { BadRequestException, Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { MONIME_SIGNATURE_HEADER } from '../domain/monime-signature';
import { InvalidWebhookPayloadError } from '../domain/monime-webhook';
import { type WebhookAck, MonimeWebhookReceiver, WebhookSignatureError } from '../application/monime-webhook.receiver';

/**
 * POST /webhooks/monime. Processed, ignored, unmatched and duplicate events get
 * 200 so Monime stops redelivering; a processing error yields 5xx and Monime retries.
 */
@Controller('webhooks/monime')
export class MonimeWebhookController {
  constructor(private readonly receiver: MonimeWebhookReceiver) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers(MONIME_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<WebhookAck> {
    try {
      return await this.receiver.receive(req.rawBody, signature);
    } catch (err) {
      if (err instanceof WebhookSignatureError) throw new UnauthorizedException(err.message);
      if (err instanceof InvalidWebhookPayloadError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
