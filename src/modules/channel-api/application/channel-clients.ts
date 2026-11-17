import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';

export interface ChannelClient {
  id: string;
  apiKey: string;
  secret: string;
}

/** Parsed once from CHANNEL_CLIENTS; fails boot if malformed. */
@Injectable()
export class ChannelClients {
  private readonly byKey: Map<string, ChannelClient>;

  constructor(config: AppConfig) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.get('CHANNEL_CLIENTS'));
    } catch {
      throw new Error('CHANNEL_CLIENTS must be JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('CHANNEL_CLIENTS must be a JSON array');
    const clients = parsed.map((c: Partial<ChannelClient>, i) => {
      if (!c.id || !c.apiKey || !c.secret || c.secret.length < 16) {
        throw new Error(`CHANNEL_CLIENTS[${i}] needs id, apiKey and a secret of ≥16 chars`);
      }
      return { id: c.id, apiKey: c.apiKey, secret: c.secret };
    });
    this.byKey = new Map(clients.map((c) => [c.apiKey, c]));
  }

  byApiKey(apiKey: string): ChannelClient | undefined {
    return this.byKey.get(apiKey);
  }
}
