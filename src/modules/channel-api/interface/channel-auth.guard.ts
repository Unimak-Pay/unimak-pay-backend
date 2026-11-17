import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { hmacSha256Hex, safeEqual } from '../../../shared/infrastructure/crypto';
import { type ChannelClient, ChannelClients } from '../application/channel-clients';

export const MAX_SKEW_SECONDS = 300;

export type ChannelRequest = Request & { rawBody?: Buffer; channelClient?: ChannelClient };

/**
 * Headers:
 *   X-Api-Key:   client api key
 *   X-Timestamp: unix seconds, within ±5 min of server time
 *   X-Signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)  (empty body for GET)
 */
@Injectable()
export class ChannelAuthGuard implements CanActivate {
  constructor(private readonly clients: ChannelClients) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ChannelRequest>();
    const apiKey = req.header('x-api-key');
    const ts = req.header('x-timestamp');
    const sig = req.header('x-signature');
    if (!apiKey || !ts || !sig) throw new UnauthorizedException('Missing auth headers');

    const client = this.clients.byApiKey(apiKey);
    if (!client) throw new UnauthorizedException('Unknown API key');

    if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) {
      throw new UnauthorizedException('Timestamp outside the allowed window');
    }
    const body = req.rawBody?.toString('utf8') ?? '';
    if (!safeEqual(hmacSha256Hex(client.secret, `${ts}.${body}`), sig.toLowerCase())) {
      throw new UnauthorizedException('Bad signature');
    }
    req.channelClient = client;
    return true;
  }
}
