import { feeTypeAccountReference } from './accounts';
import { assertCanManagePayouts, assertPayoutAffordable, canMovePayout, payoutStatusFromMonime } from './payout-policy';

describe('payout policy', () => {
  it('needs payouts.manage', () => {
    expect(() => assertCanManagePayouts(['instalments.manage'])).toThrow(/payouts.manage/);
    expect(() => assertCanManagePayouts(['payouts.manage'])).not.toThrow();
  });

  it('reserves locally requested payouts on top of the Monime balance', () => {
    expect(() => assertPayoutAffordable({ amount: 60_000n, available: 100_000n, reservedLocally: 40_000n })).not.toThrow();
    expect(() => assertPayoutAffordable({ amount: 60_001n, available: 100_000n, reservedLocally: 40_000n })).toThrow(
      expect.objectContaining({ code: 'AMOUNT_EXCEEDS_PAYABLE', message: 'Payout exceeds the available SLE 600.00' }),
    );
    expect(() => assertPayoutAffordable({ amount: 0n, available: 1n, reservedLocally: 0n })).toThrow(/positive/);
  });

  it('maps Monime statuses and only moves forward', () => {
    expect(payoutStatusFromMonime('pending')).toBe('SUBMITTED');
    expect(canMovePayout('SUBMITTED', 'COMPLETED')).toBe(true);
    expect(canMovePayout('PROCESSING', 'SUBMITTED')).toBe(false);
    expect(canMovePayout('COMPLETED', 'FAILED')).toBe(false);
    expect(canMovePayout('REQUESTED', 'FAILED')).toBe(true);
  });

  it('builds stable account references', () => {
    expect(feeTypeAccountReference('TUITION')).toBe('unimak-fee-tuition');
  });
});
