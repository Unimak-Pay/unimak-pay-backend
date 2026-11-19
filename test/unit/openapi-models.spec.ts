import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generatedBlock, replaceBlock } from '../../scripts/openapi-models';

describe('openapi.yaml generated model schemas', () => {
  it('match prisma/schema.prisma (run `pnpm openapi:models` after schema changes)', () => {
    const spec = readFileSync(path.resolve(__dirname, '../../openapi.yaml'), 'utf8');
    expect(replaceBlock(spec)).toBe(spec);
    expect(spec).toContain(generatedBlock());
  });
});
