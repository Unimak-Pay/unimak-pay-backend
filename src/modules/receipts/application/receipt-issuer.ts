import { Injectable } from '@nestjs/common';
import type { Minor } from '../../../shared/domain/money';
import type { Db } from '../../../shared/infrastructure/prisma.service';
import { formatReceiptNumber, generateVerifyCode } from '../domain/receipt';

export interface IssuedReceipt {
  id: string;
  number: string;
  verifyCode: string;
}

/** Runs inside the settlement transaction. Numbers are gap-free per year. */
@Injectable()
export class ReceiptIssuer {
  async issue(
    db: Db,
    input: { paymentId: string; payerId: string; obligationId: string; amount: Minor; issuedAt: Date },
  ): Promise<IssuedReceipt> {
    const year = input.issuedAt.getUTCFullYear(); // Sierra Leone is UTC+0
    const [row] = await db.$queryRaw<{ last: number }[]>`
      INSERT INTO "ReceiptCounter" (year, last) VALUES (${year}, 1)
      ON CONFLICT (year) DO UPDATE SET last = "ReceiptCounter".last + 1
      RETURNING last`;
    const receipt = await db.receipt.create({
      data: {
        number: formatReceiptNumber(year, row!.last),
        verifyCode: generateVerifyCode(),
        paymentId: input.paymentId,
        payerId: input.payerId,
        obligationId: input.obligationId,
        amount: input.amount,
        issuedAt: input.issuedAt,
      },
    });
    return { id: receipt.id, number: receipt.number, verifyCode: receipt.verifyCode };
  }
}
