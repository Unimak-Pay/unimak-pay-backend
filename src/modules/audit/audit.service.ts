import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type Db, PrismaService } from '../../shared/infrastructure/prisma.service';

export interface AuditEntry {
  /** AdminUser id, or "cli:<user>" / "system" */
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Append-only audit trail (DB trigger blocks UPDATE/DELETE). Write inside the change's transaction. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(e: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: e.actorId,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        before: toJson(e.before),
        after: toJson(e.after),
      },
    });
  }
}

/** bigint → string, Date → ISO; undefined → DB null. */
function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as Prisma.InputJsonValue;
}
