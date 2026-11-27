import { isCheckoutKey, isSponsorMethod, parseSleInput, payRequestWebUrl, sponsorAmount, sponsorDue } from './sponsor-checkout';

describe('sponsor checkout', () => {
  it('parses what a sponsor types', () => {
    expect(parseSleInput('150')).toBe(15_000n);
    expect(parseSleInput(' 1,500.5 ')).toBe(150_050n);
    expect(parseSleInput('SLE 2.05')).toBe(205n);
    for (const bad of ['', '0', '1.234', '-5', 'abc', '1e3', undefined]) expect(parseSleInput(bad)).toBeNull();
  });

  it('fixed request: what is left of it, capped by what the fee can take', () => {
    expect(sponsorAmount({ requested: 10_000n, paid: 0n, payable: 50_000n, entered: null })).toEqual({ ok: true, amount: 10_000n });
    expect(sponsorAmount({ requested: 10_000n, paid: 4_000n, payable: 50_000n, entered: 99n })).toEqual({ ok: true, amount: 6_000n });
    expect(sponsorAmount({ requested: 10_000n, paid: 0n, payable: 3_000n, entered: null })).toEqual({ ok: true, amount: 3_000n });
    expect(sponsorAmount({ requested: 10_000n, paid: 10_000n, payable: 3_000n, entered: null }).ok).toBe(false);
  });

  it('open request: what the sponsor typed, up to what the fee can take', () => {
    expect(sponsorAmount({ requested: null, paid: 0n, payable: 5_000n, entered: 2_000n })).toEqual({ ok: true, amount: 2_000n });
    expect(sponsorAmount({ requested: null, paid: 0n, payable: 5_000n, entered: 6_000n }).ok).toBe(false);
    expect(sponsorAmount({ requested: null, paid: 0n, payable: 5_000n, entered: null }).ok).toBe(false);
    expect(sponsorAmount({ requested: null, paid: 0n, payable: 0n, entered: 100n }).ok).toBe(false);
  });

  it('shows a fixed amount only for fixed requests', () => {
    expect(sponsorDue(10_000n, 0n, 7_000n)).toBe(7_000n);
    expect(sponsorDue(null, 0n, 7_000n)).toBeNull();
  });

  it('methods, form keys and the link', () => {
    expect(isSponsorMethod('card')).toBe(true);
    expect(isSponsorMethod('bank')).toBe(false);
    expect(isCheckoutKey('abcdefghijklmnop')).toBe(true);
    expect(isCheckoutKey('short')).toBe(false);
    expect(isCheckoutKey('a'.repeat(16) + '<')).toBe(false);
    expect(payRequestWebUrl('https://api.example/', 'ABC2345')).toBe('https://api.example/p/ABC2345');
  });
});
