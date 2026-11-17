import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { PayerKind } from '../../catalog/domain/payer-profile';

/** "applicant" | "student" → PayerKind */
export class PayerKindPipe implements PipeTransform<string, PayerKind> {
  transform(value: string): PayerKind {
    const v = value.toLowerCase();
    if (v === 'applicant') return 'APPLICANT';
    if (v === 'student') return 'STUDENT';
    throw new BadRequestException('kind must be "applicant" or "student"');
  }
}

export class RefPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new BadRequestException('Invalid ref');
    return value;
  }
}
