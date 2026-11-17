import type { IncomingMessage, ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/bootstrap';

// Cached across invocations of a warm function instance.
let appPromise: Promise<INestApplication> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  appPromise ??= createApp().catch((err: unknown) => {
    appPromise = undefined; // don't cache a failed bootstrap
    throw err;
  });
  const app = await appPromise;
  const express = app.getHttpAdapter().getInstance() as (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void;
  express(req, res);
}
