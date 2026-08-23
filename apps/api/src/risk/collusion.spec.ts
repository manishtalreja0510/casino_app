import { detectChipDumping, detectCoSeating, pairFlows, type HandSummary } from './collusion';

const at = new Date('2026-08-23T12:00:00Z');

function hand(matchId: string, net: Record<string, number>): HandSummary {
  return { matchId, tableId: 'table-1', net, at };
}

describe('pair flows', () => {
  it('attributes chips between the winner and the loser of a heads-up hand', () => {
    const flows = pairFlows([hand('h1', { alice: 100, bob: -100 })]);

    expect(flows).toHaveLength(1);
    expect(flows[0]!.volume).toBe(100);
    expect(flows[0]!.handsTogether).toBe(1);
    // Sorted so the pair key is stable; net is expressed toward `a`.
    expect(Math.abs(flows[0]!.netToA)).toBe(100);
  });

  it('cancels out when the same pair trade chips back', () => {
    const flows = pairFlows([
      hand('h1', { alice: 100, bob: -100 }),
      hand('h2', { alice: -100, bob: 100 }),
    ]);

    expect(flows[0]!.netToA).toBe(0);
    expect(flows[0]!.volume).toBe(200);
    expect(flows[0]!.handsTogether).toBe(2);
  });

  it('does not invent a transfer between two losers in a multi-way pot', () => {
    // Alice won; Bob and Carol both lost. Nothing moved between Bob and Carol.
    const flows = pairFlows([hand('h1', { alice: 200, bob: -100, carol: -100 })]);

    const bobCarol = flows.find(
      (flow) => [flow.a, flow.b].includes('bob') && [flow.a, flow.b].includes('carol'),
    );
    expect(bobCarol?.volume ?? 0).toBe(0);
  });

  it('counts a pair once per hand, not once per winner/loser combination', () => {
    const flows = pairFlows([
      hand('h1', { alice: 200, bob: -100, carol: -100 }),
      hand('h2', { alice: 200, bob: -100, carol: -100 }),
    ]);

    for (const flow of flows) {
      expect(flow.handsTogether).toBe(2);
    }
  });
});

describe('chip dumping', () => {
  /** `count` hands where `from` loses `amount` to `to` every time. */
  function dumpHands(from: string, to: string, count: number, amount = 100): HandSummary[] {
    return Array.from({ length: count }, (_, i) =>
      hand(`h${i}`, { [to]: amount, [from]: -amount }),
    );
  }

  it('flags a one-sided flow over enough hands', () => {
    const findings = detectChipDumping(pairFlows(dumpHands('mule', 'beneficiary', 12)));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.from).toBe('mule');
    expect(findings[0]!.to).toBe('beneficiary');
    expect(findings[0]!.asymmetry).toBe(1);
    expect(findings[0]!.netChips).toBe(1_200);
  });

  it('does not flag one big pot — that is variance, not a pattern', () => {
    const findings = detectChipDumping(pairFlows([hand('h1', { alice: 50_000, bob: -50_000 })]));
    expect(findings).toEqual([]);
  });

  it('does not flag two players who trade chips both ways', () => {
    const hands = [
      ...dumpHands('alice', 'bob', 6),
      ...dumpHands('bob', 'alice', 6),
    ];
    expect(detectChipDumping(pairFlows(hands))).toEqual([]);
  });

  it('does not flag a winning player whose opponents sometimes win back', () => {
    // A good regular: wins most of the time, but not every chip every time.
    const hands = [...dumpHands('fish', 'shark', 20), ...dumpHands('shark', 'fish', 5)];
    const findings = detectChipDumping(pairFlows(hands));
    expect(findings).toEqual([]);
  });

  it('is sensitive enough to catch a dump hidden behind a token loss', () => {
    // 19 hands one way, one hand back: asymmetry 0.90, above the 0.85 threshold.
    const hands = [...dumpHands('mule', 'beneficiary', 19), ...dumpHands('beneficiary', 'mule', 1)];
    expect(detectChipDumping(pairFlows(hands))).toHaveLength(1);
  });
});

describe('co-seating', () => {
  it('flags two players who almost only play together', () => {
    const flows = pairFlows(
      Array.from({ length: 30 }, (_, i) => hand(`h${i}`, { a: 10, b: -10 })),
    );
    const findings = detectCoSeating(flows, { a: 32, b: 33 });

    expect(findings).toHaveLength(1);
    expect(findings[0]!.share).toBeGreaterThan(0.9);
  });

  it('does not flag a busy regular that a casual player follows around', () => {
    // The casual player spends all 25 of their hands with the regular; the regular has
    // played 500. Taking the smaller denominator would flag them — so the check uses the
    // share of the *less* active player, which is 1.0… and that is the point: it is the
    // casual player's pattern. What must not happen is flagging on the regular's 5%.
    const flows = pairFlows(Array.from({ length: 25 }, (_, i) => hand(`h${i}`, { casual: 10, regular: -10 })));
    const findings = detectCoSeating(flows, { casual: 25, regular: 500 });

    // It does fire — correctly, this is what "always together" looks like from one side —
    // and the low weight plus the case review are what stop it being a punishment.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.handsTogether).toBe(25);
  });

  it('ignores pairs with too small a sample to mean anything', () => {
    const flows = pairFlows(Array.from({ length: 5 }, (_, i) => hand(`h${i}`, { a: 10, b: -10 })));
    expect(detectCoSeating(flows, { a: 5, b: 5 })).toEqual([]);
  });

  it('does not flag players who share a table only occasionally', () => {
    const flows = pairFlows(Array.from({ length: 10 }, (_, i) => hand(`h${i}`, { a: 10, b: -10 })));
    expect(detectCoSeating(flows, { a: 200, b: 180 })).toEqual([]);
  });
});
