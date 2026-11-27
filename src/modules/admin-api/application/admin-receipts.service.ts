import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { AcademicsService, NO_NAMES } from '../../academics/application/academics.service';
import type { AdminPrincipal } from '../../auth/application/admin-principal';
import { paymentMethodLabel } from '../../dot-extras/domain/history';
import { normalizePublicRef, PAYMENT_REF } from '../../payments/domain/payment-ref';
import { normalizeReceiptNumber } from '../../receipts/domain/receipt-number';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

export interface ReceiptFilters {
  /** YYYY-MM-DD, inclusive (UTC = Africa/Freetown), by issue date */
  from?: string;
  to?: string;
  feeType?: string;
  faculty?: string;
  department?: string;
  channel?: 'USSD' | 'DOTS' | 'WEB';
  payerRef?: string;
  /** a receipt number, payment ref or Monime order number */
  q?: string;
}

const include = {
  payer: true,
  obligation: { include: { fee: { include: { feeType: true } } } },
  payment: true,
} satisfies Prisma.ReceiptInclude;
type Row = Prisma.ReceiptGetPayload<{ include: typeof include }>;

/** Receipts for the admin (docs: README "Admin API"). Heads of department and deans see their departments only. */
@Injectable()
export class AdminReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly academics: AcademicsService,
  ) {}

  async list(admin: AdminPrincipal, q: ReceiptFilters & { limit: number; cursor?: string }) {
    const rows = await this.prisma.receipt.findMany({
      where: await this.where(admin, q),
      include,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    const names = await this.academics.names(page.map((r) => r.payer.department));
    return {
      items: page.map((r) => this.row(r, names.get(r.payer.department ?? '') ?? NO_NAMES)),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  }

  /** By receipt number (case, spaces and dashes ignored); 404 outside the admin's departments. */
  async byNumber(admin: AdminPrincipal, raw: string) {
    const number = normalizeReceiptNumber(raw);
    const r = number ? await this.prisma.receipt.findUnique({ where: { number }, include }) : null;
    if (!r || (admin.departmentScoped && !admin.departments.includes(r.payer.department ?? ''))) throw new DomainError('NOT_FOUND', 'Receipt not found');
    const names = (await this.academics.names([r.payer.department])).get(r.payer.department ?? '') ?? NO_NAMES;
    const p = r.payment;
    return {
      ...this.row(r, names),
      payment: {
        ...this.row(r, names).payment,
        amount: p.amount, monimeFee: p.monimeFee, platformFee: p.platformFee, netAmount: p.netAmount,
        monimeOrderNumber: p.monimeOrderNumber, monimePaymentId: p.monimePaymentId,
        createdAt: p.createdAt, completedAt: p.completedAt,
      },
    };
  }

  private row(r: Row, names: { departmentName: string; facultyCode: string | null; facultyName: string | null }) {
    return {
      id: r.id,
      number: r.number,
      amount: r.amount,
      issuedAt: r.issuedAt,
      verifyUrl: `${this.config.get('PUBLIC_BASE_URL').replace(/\/+$/, '')}/r/${r.verifyCode}`,
      payer: {
        id: r.payer.id, kind: r.payer.kind, ref: r.payer.ref, fullName: r.payer.fullName,
        department: r.payer.department, departmentName: names.departmentName || null, facultyCode: names.facultyCode, facultyName: names.facultyName,
      },
      fee: { id: r.obligation.fee.id, name: r.obligation.fee.name, period: r.obligation.fee.period, feeTypeCode: r.obligation.fee.feeType.code },
      obligationId: r.obligationId,
      payment: {
        id: r.payment.id, paymentRef: r.payment.paymentRef, channel: r.payment.channel,
        method: paymentMethodLabel(r.payment.monimeChannelType),
        paidBy: { name: r.payment.paidByName, self: r.payment.payingForSelf },
      },
    };
  }

  private async where(admin: AdminPrincipal, q: ReceiptFilters): Promise<Prisma.ReceiptWhereInput> {
    for (const v of [q.from, q.to]) if (v !== undefined && (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new DomainError('VALIDATION', 'from/to must be dates (YYYY-MM-DD)');
    const facultyDepartments = q.faculty
      ? (await this.prisma.department.findMany({ where: { faculty: { code: q.faculty } }, select: { code: true } })).map((d) => d.code)
      : null;
    const text = q.q?.trim();
    const number = text ? normalizeReceiptNumber(text) : null;
    const ref = text ? normalizePublicRef(text) : null;
    return {
      AND: [
        admin.departmentScoped ? { payer: { department: { in: [...admin.departments] } } } : {},
        q.from ? { issuedAt: { gte: new Date(`${q.from}T00:00:00Z`) } } : {},
        q.to ? { issuedAt: { lt: new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY) } } : {},
        q.feeType ? { obligation: { fee: { feeType: { code: q.feeType } } } } : {},
        q.department ? { payer: { department: q.department } } : {},
        facultyDepartments ? { payer: { department: { in: facultyDepartments } } } : {},
        q.channel ? { payment: { channel: q.channel } } : {},
        q.payerRef ? { payer: { ref: q.payerRef } } : {},
        text
          ? {
              OR: [
                ...(number ? [{ number }] : []),
                ...(ref && PAYMENT_REF.test(ref) ? [{ payment: { paymentRef: ref } }] : []),
                ...(ref ? [{ payment: { monimeOrderNumber: ref } }] : []),
                // nothing recognisable: match nothing rather than everything
                ...(!number && !ref ? [{ id: '00000000-0000-0000-0000-000000000000' }] : []),
              ],
            }
          : {},
      ],
    };
  }
}
