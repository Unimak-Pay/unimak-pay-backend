import { DomainError } from '../../../shared/domain/errors';
import { bpsOfHalfUp, maxBig, type Minor } from '../../../shared/domain/money';

export interface PricingRates {
  /** total UNIMAK gives up, bps (250 = 2.5%) */
  totalRateBps: number;
  monimeRateBps: number;
  /** flat Monime fee, minor units */
  monimeFlat: Minor;
}

export interface FeeSplit {
  amount: Minor;
  total: Minor;
  monimeFee: Minor;
  platformFee: Minor;
  netAmount: Minor;
}

/**
 * The payer pays `amount`, nothing extra. UNIMAK gives up totalRate of it:
 *   total    = round_half_up(amount × totalRate)
 *   monime   = round_half_up(amount × monimeRate) + monimeFlat
 *   platform = max(total − monime, 0)
 *   net      = amount − monime − platform
 * When Monime's fee exceeds the total (e.g. DOTS under SLE 20), platform is 0
 * and UNIMAK absorbs the Monime fee.
 */
export function splitFees(amount: Minor, rates: PricingRates): FeeSplit {
  if (amount <= 0n) throw new DomainError('VALIDATION', 'Amount must be positive');
  const total = bpsOfHalfUp(amount, rates.totalRateBps);
  const monimeFee = bpsOfHalfUp(amount, rates.monimeRateBps) + rates.monimeFlat;
  const platformFee = maxBig(total - monimeFee, 0n);
  const netAmount = amount - monimeFee - platformFee;
  if (netAmount < 0n) {
    throw new DomainError('VALIDATION', 'Amount is smaller than the transaction fee', {
      amount: amount.toString(),
      monimeFee: monimeFee.toString(),
    });
  }
  return { amount, total, monimeFee, platformFee, netAmount };
}
