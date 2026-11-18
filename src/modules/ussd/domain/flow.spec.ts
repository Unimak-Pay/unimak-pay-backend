import { parseExchangeRequest, parseSleInput, sleShort } from './flow';

describe('USSD flow helpers', () => {
  it('parses keypad amounts into minor units', () => {
    expect(parseSleInput('1500')).toBe(150_000n);
    expect(parseSleInput('1,500.5')).toBe(150_050n);
    expect(parseSleInput('1500*25')).toBe(150_025n);
    expect(parseSleInput('abc')).toBeNull();
    expect(parseSleInput('1.234')).toBeNull();
    expect(parseSleInput('-5')).toBeNull();
  });
  it('formats short amounts', () => {
    expect(sleShort(450_000n)).toBe('SLE 4,500');
    expect(sleShort(450_050n)).toBe('SLE 4,500.50');
  });
  it('validates the exchange request shape and drops non-string flowData', () => {
    expect(parseExchangeRequest({ currentPage: 'start' })).toBeNull();
    expect(parseExchangeRequest({ global: { sessionId: 's', subscriberId: 'u' }, currentPage: 'x', flowData: { a: '1', b: 2 } })?.flowData).toEqual({ a: '1' });
  });
});

describe('collect_payment amount', () => {
  it('is in major units', () => {
    const { toMajorAmount } = jest.requireActual('./flow');
    expect(toMajorAmount(250_000n)).toBe('2500');
    expect(toMajorAmount(250_050n)).toBe('2500.50');
    expect(toMajorAmount(5n)).toBe('0.05');
  });
});

describe('flow template', () => {
  // Page data from an exchange reply applies only to the page it navigates to;
  // a page reached by `on_done: next` gets none, so it must not use $(data.…).
  it('pages reached by `next` do not read exchange page data', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tpl = require('../../../../ussd/unimak-flow.template.json') as { pages: { id: string; component: unknown; on_done?: { action: string; next_page?: string } }[] };
    const nextTargets = new Set(tpl.pages.filter((p) => p.on_done?.action === 'next').map((p) => p.on_done!.next_page));
    const offenders = tpl.pages.filter((p) => nextTargets.has(p.id) && JSON.stringify(p.component).includes('$(data.')).map((p) => p.id);
    expect(offenders).toEqual([]);
  });
});
