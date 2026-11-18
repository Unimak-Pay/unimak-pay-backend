import { Body, Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfig } from '../../../config/app-config';
import { safeEqual } from '../../../shared/infrastructure/crypto';
import { UssdFlowService } from '../application/ussd-flow.service';
import { UssdKeys } from '../application/ussd-keys';
import { decryptExchange, encryptReply, ExchangeCryptoError } from '../domain/exchange-crypto';
import { type ExchangeReply, parseExchangeRequest } from '../domain/flow';

/**
 * Monime USSD flow exchange: POST /v1/ussd/exchange/<USSD_EXCHANGE_PATH_TOKEN>
 * Request: { encryptedAesKey, encryptedExchangeData } (RSA-OAEP-SHA256 + AES-128-GCM).
 * Reply: base64 AES-GCM blob, text/plain, HTTP 200 within 10 s.
 *
 * Monime does not sign these requests, so: secret URL token (wrong → 404),
 * optional IP allowlist, server-side session state, per-subscriber rate
 * limits, and every money fact checked against our own records.
 */
@Controller('v1/ussd/exchange')
export class UssdExchangeController {
  private readonly logger = new Logger(UssdExchangeController.name);

  constructor(
    private readonly config: AppConfig,
    private readonly keys: UssdKeys,
    private readonly flow: UssdFlowService,
  ) {}

  /** Health check for the flow's own testing; reveals nothing beyond "configured". */
  @Get(':token')
  health(@Param('token') token: string, @Req() req: Request) {
    this.authorize(token, req);
    return { status: 'ok', encryption: 'RSA-OAEP-SHA256 + AES-128-GCM', keys: this.keys.keys.length };
  }

  @Post(':token')
  @HttpCode(200)
  async exchange(@Param('token') token: string, @Req() req: Request, @Body() body: unknown, @Res() res: Response): Promise<void> {
    this.authorize(token, req);
    const encrypted = !!body && typeof body === 'object' && 'encryptedAesKey' in body;

    if (!encrypted) {
      const allowPlain = this.config.get('USSD_ALLOW_PLAINTEXT') && !this.config.isProduction;
      const plain = allowPlain ? parseExchangeRequest(body) : null;
      if (!plain) {
        res.status(400).json({ action: 'stop', message: 'Invalid request' });
        return;
      }
      res.json(await this.run(plain));
      return;
    }

    if (this.keys.keys.length === 0) throw new ServiceUnavailableException('USSD exchange not configured');
    let decrypted;
    try {
      decrypted = decryptExchange(body, this.keys.keys);
    } catch (err) {
      if (err instanceof ExchangeCryptoError) {
        this.logger.warn(`USSD decryption failed: ${err.message}`);
        res.status(400).json({ action: 'stop', message: 'Decryption failed' });
        return;
      }
      throw err;
    }
    const request = parseExchangeRequest(decrypted.request);
    const reply = request ? await this.run(request) : { action: 'stop' as const, message: 'Invalid request' };
    res.type('text/plain').send(encryptReply(reply, decrypted.aesKey));
  }

  private async run(request: NonNullable<ReturnType<typeof parseExchangeRequest>>): Promise<ExchangeReply> {
    try {
      return await this.flow.handle(request);
    } catch (err) {
      // Never leave the subscriber on a dead screen: Monime ends the session on non-200.
      this.logger.error(`USSD ${request.global.sessionId} ${request.currentPage}: ${(err as Error).message}`);
      return { action: 'stop', message: 'Service temporarily unavailable. Please try again later.' };
    }
  }

  private authorize(token: string, req: Request): void {
    const expected = this.config.get('USSD_EXCHANGE_PATH_TOKEN');
    if (!expected || !safeEqual(token, expected)) throw new NotFoundException();
    const allow = this.config.get('USSD_ALLOWED_IPS');
    if (allow) {
      const ip = clientIp(req);
      if (!allow.split(',').map((s) => s.trim()).filter(Boolean).includes(ip)) {
        this.logger.warn(`USSD exchange from non-allowlisted IP ${ip}`);
        throw new NotFoundException();
      }
    }
  }
}

function clientIp(req: Request): string {
  const fwd = req.header('x-vercel-forwarded-for') ?? req.header('x-forwarded-for') ?? '';
  return fwd.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}
