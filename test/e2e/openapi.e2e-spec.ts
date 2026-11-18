import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';

/**
 * openapi.yaml must list exactly the routes the app serves. Parsed with a
 * regex (no YAML dependency): paths are the 2-space-indented "/…:" keys,
 * operations the 4-space-indented verbs under them.
 */
function specRoutes(): Set<string> {
  const out = new Set<string>();
  let current: string | null = null;
  for (const line of readFileSync(path.resolve('openapi.yaml'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) current = null; // left the paths block
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) current = p[1]!;
    const op = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (op && current) out.add(`${op[1]!.toUpperCase()} ${current}`);
  }
  return out;
}

function appRoutes(app: INestApplication): Set<string> {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } };
  const out = new Set<string>();
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    const p = layer.route.path.replace(/:(\w+)/g, '{$1}');
    for (const [m, on] of Object.entries(layer.route.methods)) if (on && m !== '_all') out.add(`${m.toUpperCase()} ${p}`);
  }
  return out;
}

describe('openapi.yaml', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(); // NODE_ENV=test: includes the dev routes, which the spec documents too
  });
  afterAll(() => app.close());

  it('documents every route the app serves, and nothing else', () => {
    const spec = specRoutes();
    const served = appRoutes(app);
    expect(served.size).toBeGreaterThan(50);
    expect({ undocumented: [...served].filter((r) => !spec.has(r)).sort(), notServed: [...spec].filter((r) => !served.has(r)).sort() })
      .toEqual({ undocumented: [], notServed: [] });
  });
});
