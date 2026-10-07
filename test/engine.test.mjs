// The bot's decisions (engine.mjs): the owner's switches, the chain over the signal, the site's strategy, the limits.
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, verifySignal, reconcile, emptyLedger, limitsOf } from '../src/engine.mjs';
import { NOW, rawSeries, viewOf, sigOf } from './fixtures.mjs';
const T = NOW / 1000;

const settings = (over = {}) => ({ mode: 'paper', limits: { maxSpendPerSeries: 500 }, ...over });
const ledger = (mode = 'paper', tranches = [], series = {}) => ({ ...emptyLedger(mode), tranches, series });

test('limits default from the series budget; nothing trades without one', () => {
  assert.deepEqual(limitsOf({ limits: { maxSpendPerSeries: 500 } }), { maxSpendPerSeries: 500, maxTicket: 100, lossStopSeries: 250, lossStopTotal: 500, reserveUsdg: 0 });
  const p = plan({ st: ledger(), view: viewOf(), sig: sigOf(), settings: { limits: {} }, now: NOW });
  assert.equal(p.actions.length, 0); assert.match(p.blocks[0], /no series budget/);
});

test('the signal must describe the chain: series, line, freshness, rfv, checks present', () => {
  const v = viewOf(), ck = { requireHealth: true, requireRfvMatch: true, rfvTolerancePct: 0.5, maxSignalAgeMin: 15 };
  assert.equal(verifySignal(sigOf(), v, ck, NOW).ok, true);
  assert.match(verifySignal(sigOf({ id: 3 }), v, ck, NOW).problems.join(), /series #3/);
  assert.match(verifySignal(sigOf({ line: 28_000_000 }), v, ck, NOW).problems.join(), /line/);
  assert.match(verifySignal(sigOf({ ts: NOW - 40 * 60e3 }), v, ck, NOW).problems.join(), /40 min/);
  assert.match(verifySignal(sigOf({ rfv: 23_500_000 }), v, ck, NOW).problems.join(), /rfv/);
  assert.match(verifySignal(sigOf({ health: null }), v, ck, NOW).problems.join(), /pre-trade checks/);
  assert.match(verifySignal(null, v, ck, NOW).problems.join(), /could not be read/);
});

test('an edge opens the first ticket at the owner\'s largest ticket, priced on the curve', () => {
  const p = plan({ st: ledger(), view: viewOf(), sig: sigOf(), settings: settings(), now: NOW });
  const b = p.actions.find((a) => a.type === 'BUY');
  assert.equal(b.side, 'HIGHER'); assert.equal(b.kind, 'OPEN'); assert.equal(b.spend, 100);
  assert.ok(b.fill.tokens > 100 && b.fill.tokens < 200);
});

test('the series budget caps the spend; a used budget blocks', () => {
  const tr = [{ id: 't1', seriesId: 4, side: 'HIGHER', tokens: 300, costUsdg: 150, spendUsdg: 150, avgPrice: 0.5, openedAt: NOW - 3 * 3600e3, status: 'OPEN' }];
  const sig = sigOf({ pH: 0.9 });
  // budget 500, 460 already spent (incl. closed tranches): at most 40 more
  let p = plan({ st: ledger('paper', tr, { 4: { spent: 460, realized: 0 } }), view: viewOf(), sig, settings: settings(), now: NOW });
  const b = p.actions.find((a) => a.type === 'BUY');
  assert.equal(b.kind, 'ADD'); assert.equal(b.spend, 40);
  p = plan({ st: ledger('paper', tr, { 4: { spent: 500, realized: 0 } }), view: viewOf(), sig, settings: settings(), now: NOW });
  assert.equal(p.actions.filter((a) => a.type === 'BUY').length, 0);
});

test('failed checks: no buys and no edge stops; take-profit still sells on the desk\'s quote', () => {
  const blocked = sigOf({ health: { ok: false, blockEntries: true, holdStops: true, reason: 'jump' } });
  assert.equal(plan({ st: ledger(), view: viewOf(), sig: blocked, settings: settings(), now: NOW }).actions.length, 0);
  // live: a tranche bought at 30¢ the desk now buys back for +60%
  const t = { id: 't1', seriesId: 4, side: 'HIGHER', tokens: 100, costUsdg: 30, spendUsdg: 30, avgPrice: 0.3, openedAt: NOW - 86400e3, status: 'OPEN' };
  const v = viewOf({ marks: { t1: 48 }, held: { 4: { HIGHER: 100, LOWER: 0 } } });
  const p = plan({ st: ledger('live', [t], { 4: { spent: 30, realized: 0 } }), view: v, sig: blocked, settings: settings({ mode: 'live' }), now: NOW });
  assert.deepEqual(p.actions.map((a) => a.type), ['SELL']); assert.match(p.actions[0].reason, /take-profit/);
  // the model now says LOWER (edge stop), but the checks hold stops
  const p2 = plan({ st: ledger('live', [t], { 4: { spent: 30, realized: 0 } }), view: viewOf({ marks: { t1: 31 } }), sig: sigOf({ pH: 0.1, health: { blockEntries: true, holdStops: true, reason: 'jump' } }), settings: settings({ mode: 'live' }), now: NOW });
  assert.equal(p2.actions.length, 0);
});

test('an unverified signal is not traded on, even when its checks say ok', () => {
  const p = plan({ st: ledger(), view: viewOf(), sig: sigOf({ rfv: 20_000_000 }), settings: settings(), now: NOW });
  assert.equal(p.actions.length, 0); assert.match(p.decision, /signal/);
});

test('loss stops: the total latches and blocks buys; a latched series blocks its buys', () => {
  const t = { id: 't1', seriesId: 4, side: 'LOWER', tokens: 1000, costUsdg: 400, spendUsdg: 400, avgPrice: 0.4, openedAt: NOW - 86400e3, status: 'OPEN' };
  const st = ledger('live', [t], { 4: { spent: 400, realized: -150 } }); st.realizedSinceReset = -150;
  const p = plan({ st, view: viewOf({ marks: { t1: 100 }, held: { 4: { LOWER: 1000 } } }), sig: sigOf({ pH: 0.2 }), settings: settings({ mode: 'live', limits: { maxSpendPerSeries: 600, lossStopTotal: 400 } }), now: NOW });
  assert.equal(p.latch.series.loss, -450); assert.equal(p.latch.total.loss, -450);
  assert.equal(p.actions.filter((a) => a.type === 'BUY').length, 0);
  const st2 = ledger('paper'); st2.lossStop = { tripped: true };
  const p2 = plan({ st: st2, view: viewOf(), sig: sigOf(), settings: settings(), now: NOW });
  assert.equal(p2.actions.length, 0); assert.match(p2.blocks[0], /loss stop/);
});

test('the kill switch: stopped sends nothing; sell-all sells open tranches and redeems settled ones', () => {
  const a = { id: 't1', seriesId: 4, side: 'HIGHER', tokens: 100, costUsdg: 50, spendUsdg: 50, avgPrice: 0.5, openedAt: NOW - 86400e3, status: 'OPEN' };
  const b = { id: 't2', seriesId: 3, side: 'LOWER', tokens: 80, costUsdg: 40, spendUsdg: 40, avgPrice: 0.5, openedAt: NOW - 9 * 86400e3, status: 'OPEN' };
  const graded = { ...rawSeries({ statusRaw: 2, printNumber: 27_000_000, longPayout: 0, gradedAt: T - 86400 }), seriesId: 3 };
  const v = viewOf({ extra: { 3: graded }, marks: { t1: 55 } });
  assert.equal(plan({ st: ledger('live', [a, b]), view: v, sig: sigOf(), settings: settings({ mode: 'live' }), control: { stopped: true }, now: NOW }).actions.length, 0);
  const p = plan({ st: ledger('live', [a, b]), view: v, sig: sigOf(), settings: settings({ mode: 'live' }), control: { stopped: true, flatten: true }, now: NOW });
  assert.deepEqual(p.actions.map((x) => x.type), ['REDEEM', 'SELL']);
  assert.equal(p.actions[0].payout, 80); assert.equal(p.actions[0].won, true);
});

test('a graded series redeems once per side', () => {
  const graded = { ...rawSeries({ statusRaw: 2, printNumber: 29_000_000, longPayout: 1e6 / 1e6, gradedAt: T - 86400 }), seriesId: 3 };
  const tr = [1, 2].map((i) => ({ id: 't' + i, seriesId: 3, side: 'HIGHER', tokens: 50, costUsdg: 20, spendUsdg: 20, avgPrice: 0.4, openedAt: NOW - 9 * 86400e3, status: 'OPEN' }));
  const p = plan({ st: ledger('live', tr), view: viewOf({ extra: { 3: graded } }), sig: sigOf({ pH: 0.5 }), settings: settings({ mode: 'live' }), now: NOW });
  const r = p.actions.filter((a) => a.type === 'REDEEM');
  assert.equal(r.length, 1); assert.equal(r[0].tokens, 100); assert.equal(r[0].payout, 100); assert.equal(r[0].tranches.length, 2);
});

test('live: the chain already holds the bot\'s tokens (no paper overlay), and the wallet caps the spend', () => {
  const p = plan({ st: ledger('live'), view: viewOf({ usdg: 37.5 }), sig: sigOf(), settings: settings({ mode: 'live' }), now: NOW });
  const b = p.actions.find((a) => a.type === 'BUY');
  assert.equal(b.spend, 37.5); assert.equal(b.fill, null);
  assert.match(plan({ st: ledger('live'), view: viewOf({ usdg: 0.5 }), sig: sigOf(), settings: settings({ mode: 'live' }), now: NOW }).blocks[0], /not enough USDG/);
  assert.match(plan({ st: ledger('live'), view: viewOf({ eth: 0 }), sig: sigOf(), settings: settings({ mode: 'live' }), now: NOW }).blocks[0], /ETH for gas/);
});

test('reconcile: a position sold by hand shrinks the bot\'s record to the wallet', () => {
  const t = { id: 't1', seriesId: 4, side: 'HIGHER', tokens: 100, costUsdg: 50, spendUsdg: 50, avgPrice: 0.5, openedAt: NOW, status: 'OPEN' };
  const st = ledger('live', [t]);
  const n = reconcile(st, { held: { 4: { HIGHER: 40 } } });
  assert.equal(n.length, 1); assert.equal(t.tokens, 40); assert.equal(t.costUsdg, 20);
  assert.equal(reconcile(st, { held: { 4: { HIGHER: 40 } } }).length, 0);
});
