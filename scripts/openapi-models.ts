/**
 * Generates the OpenAPI schemas of the database rows the admin API returns,
 * from prisma/schema.prisma (via the generated client's DMMF), into the marked
 * block of openapi.yaml. `test/unit/openapi-models.spec.ts` fails when the block
 * is stale.
 *
 *   pnpm openapi:models
 *
 * Wire format (BigIntJsonInterceptor): BigInt → string of minor units,
 * DateTime → ISO string, Json → as stored. Every field is always present.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { Document, isMap, isSeq, type YAMLMap } from 'yaml';

/** Models the admin API returns as rows (alone or with extra fields). */
export const MODELS = [
  'AdminUser', 'AuditLog', 'EligibilityRule', 'Fee', 'FeeType', 'FinancialAccount', 'InstalmentRule', 'LedgerEntry',
  'OutboxMessage', 'Payment', 'Payout', 'RateRule', 'ReconciliationItem', 'ReconciliationRun', 'Transfer', 'WebhookEvent',
] as const;

/** Row shapes with fields left out (e.g. lists that omit the payload). */
const VARIANTS: Record<string, { from: (typeof MODELS)[number]; omit: string[]; description: string }> = {
  WebhookEventSummary: { from: 'WebhookEvent', omit: ['payload'], description: 'A webhook event without its payload (GET /v1/admin/reconciliation/webhook-events/{id} has it).' },
};

/** Fields whose wire format differs from the column type. */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  'Fee.dueDate': { type: ['string', 'null'], format: 'date', description: 'Calendar day (YYYY-MM-DD).' },
};

export const BEGIN = '    # ── BEGIN generated from prisma/schema.prisma by `pnpm openapi:models` — do not edit ──';
export const END = '    # ── END generated ──';

const clean = (doc: string) => doc.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();

type Field = (typeof Prisma.dmmf.datamodel.models)[number]['fields'][number];

function fieldSchema(model: string, f: Field): Record<string, unknown> {
  const override = OVERRIDES[`${model}.${f.name}`];
  if (override) return override;
  const doc = f.documentation ? { description: clean(f.documentation) } : {};
  let s: Record<string, unknown>;
  if (f.kind === 'enum') {
    s = f.isRequired ? { $ref: `#/components/schemas/${f.type}` } : { oneOf: [{ $ref: `#/components/schemas/${f.type}` }, { type: 'null' }] };
    return f.isList ? { type: 'array', items: { $ref: `#/components/schemas/${f.type}` }, ...doc } : { ...s, ...doc };
  }
  switch (f.type) {
    case 'String': s = { type: 'string', ...(f.nativeType?.[0] === 'Uuid' ? { format: 'uuid' } : {}) }; break;
    case 'Int': s = { type: 'integer' }; break;
    case 'Boolean': s = { type: 'boolean' }; break;
    case 'DateTime': s = { type: 'string', format: 'date-time' }; break;
    case 'BigInt': s = { type: 'string', pattern: '^-?\\d+$', description: `SLE minor units${f.documentation ? `. ${doc.description}` : ''}` }; break;
    case 'Json': return { description: f.documentation ? `JSON. ${doc.description}` : 'JSON' };
    default: throw new Error(`Unmapped Prisma type ${f.type} (${model}.${f.name})`);
  }
  if (f.isList) return { type: 'array', items: s, ...doc };
  if (!f.isRequired) s = { ...s, type: [s.type, 'null'] };
  return { ...doc, ...s, ...(s.description ? {} : doc) };
}

export function generateModelSchemas(): Record<string, unknown> {
  const models = Prisma.dmmf.datamodel.models.filter((m) => (MODELS as readonly string[]).includes(m.name));
  const out: Record<string, unknown> = {};
  const enums = new Set<string>();
  for (const m of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
    const fields = m.fields.filter((f) => f.kind !== 'object');
    for (const f of fields) if (f.kind === 'enum') enums.add(f.type);
    out[m.name] = {
      type: 'object',
      ...(m.documentation ? { description: clean(m.documentation) } : {}),
      required: fields.map((f) => f.name),
      properties: Object.fromEntries(fields.map((f) => [f.name, fieldSchema(m.name, f)])),
    };
  }
  for (const [name, v] of Object.entries(VARIANTS)) {
    const base = out[v.from] as { required: string[]; properties: Record<string, unknown> };
    out[name] = {
      type: 'object',
      description: v.description,
      required: base.required.filter((f) => !v.omit.includes(f)),
      properties: Object.fromEntries(Object.entries(base.properties).filter(([f]) => !v.omit.includes(f))),
    };
  }
  for (const e of Prisma.dmmf.datamodel.enums.filter((x) => enums.has(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    out[e.name] = { type: 'string', enum: e.values.map((v) => v.name) };
  }
  return out;
}

/** The block as it appears under components.schemas (4-space indent). */
export function generatedBlock(): string {
  // One line per field: `required` and each property schema in flow style.
  const doc = new Document(generateModelSchemas());
  for (const schema of (doc.contents as YAMLMap).items) {
    const m = schema.value as YAMLMap;
    const req = m.get('required', true);
    if (isSeq(req)) req.flow = true;
    const props = m.get('properties', true);
    if (isMap(props)) for (const p of props.items) if (isMap(p.value)) p.value.flow = true;
    const en = m.get('enum', true);
    if (isSeq(en)) en.flow = true;
  }
  const body = doc.toString({ lineWidth: 0, indent: 2, flowCollectionPadding: true })
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  return `${BEGIN}\n${body}\n${END}`;
}

export function replaceBlock(spec: string, block = generatedBlock()): string {
  const i = spec.indexOf(BEGIN);
  const j = spec.indexOf(END);
  if (i < 0 || j < 0) throw new Error('openapi.yaml has no generated block markers');
  return spec.slice(0, i) + block + spec.slice(j + END.length);
}

if (require.main === module) {
  const file = path.resolve(__dirname, '..', 'openapi.yaml');
  const before = readFileSync(file, 'utf8');
  const after = replaceBlock(before);
  writeFileSync(file, after);
  process.stdout.write(before === after ? 'openapi.yaml models already up to date\n' : 'openapi.yaml models regenerated\n');
}
