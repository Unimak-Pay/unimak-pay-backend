import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvSchema } from './env.schema';

/** Typed accessor over the validated env. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<EnvSchema, true>) {}

  get<K extends keyof EnvSchema>(key: K): EnvSchema[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}
