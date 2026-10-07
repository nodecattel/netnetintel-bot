// Shared fixtures: a live series, a chain view of it, and a signal that agrees with the chain.
import { deriveSeries } from '../src/vendor/strategy.mjs';

export const NOW = Date.parse('2026-10-08T12:00:00Z');
const T = NOW / 1000;
export function rawSeries(over = {}) {
  return { statusRaw: 1, openTime: T - 2 * 86400, lastCallTime: T + 3 * 86400, closeTime: T + 3 * 86400 + 7200, printTime: T + 4 * 86400, gradedAt: null,
    openNumber: 28_000_000, line: 28_400_000, lineRaw: '28400000000000000000', higherToken: '0x' + 'a'.repeat(40), lowerToken: '0x' + 'b'.repeat(40),
    higherOut: 1000, lowerOut: 1000, bookUsdg: 2000, virtualLiquidity: 1000, backing: 5000, volume: 0, feesTotal: 0, netSpent: 0, vaultFees: 0,
    lastPrice: 0.5, printNumber: null, printRaw: null, longPayout: 0, prizePot: 0, prizePaid: false, bestGuesser: null, guessCount: 0, ...over };
}
export function viewOf({ id = 4, raw = rawSeries(), extra = {}, ...over } = {}) {
  const bySeries = { [id]: { ...raw, seriesId: id, halted: false }, ...extra };
  return { block: 1, count: id, halted: false, minTicket: 1, rfv: 23_220_000, bySeries, cur: { ...deriveSeries(bySeries[id], NOW), seriesId: id },
    me: '0x' + 'c'.repeat(40), usdg: 1000, eth: 0.01, held: {}, marks: {}, allowance: 0n, ...over };
}
export function sigOf({ id = 4, pH = 0.75, line = 28_400_000, rfv = 23_220_000, health = { ok: true, blockEntries: false, holdStops: false, reason: '' }, ts = NOW - 60e3 } = {}) {
  return { market: { current: { seriesId: id, line } }, number: { timestamp: ts, rfv, number: 28_130_000 }, model: { pH, pL: 1 - pH, line, dailyPoints: 10 }, health };
}
