// A whole tick (trader.mjs) against a fake chain, signal and relay: paper fills, live signing with a re-quote before
// it, the Telegram stop / sell-all / resume, and what the relay is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStore } from '../src/store.mjs';
import { makeBot } from '../src/trader.mjs';
import { SIGNAL_URL, RELAY_URL, SEL } from '../src/constants.mjs';
import { rawSeries, sigOf, NOW } from './fixtures.mjs';

const hex = (n) => BigInt(Math.round(n)).toString(16).padStart(64, '0');
function encodeSeries(s) {
  const W = [s.statusRaw, s.openTime, s.lastCallTime, s.closeTime, s.printTime, s.gradedAt || 0, s.openNumber * 1e12, s.line * 1e12, 0, 0,
    s.higherOut * 1e18, s.lowerOut * 1e18, s.bookUsdg * 1e6, s.virtualLiquidity * 1e6, s.backing * 1e6, 0, 0, 0, 0, s.lastPrice * 1e18,
    (s.printNumber || 0) * 1e12, s.longPayout * 1e6, 0, 0, 0, 0].map((v) => hex(v));
  W[8] = s.higherToken.slice(2).padStart(64, '0'); W[9] = s.lowerToken.slice(2).padStart(64, '0');
  return '0x' + W.join('');
}

function world({ series = rawSeries(), pH = 0.75, health } = {}) {
  const w = { series, sig: sigOf({ pH, ...(health ? { health } : {}) }), relay: { stop: false, flattenSeq: 0, resetSeq: 0 }, reports: [], polls: 0, usdg: 1000, tokens: 0 };
  w.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
    if (url === SIGNAL_URL) return json(w.sig);
    if (url === RELAY_URL) {
      if (body.token !== 'nnib_' + 'x'.repeat(40)) return json({ error: 'unknown' }, 401);
      if (body.action === 'poll') { w.polls++; return json({ ok: true, ...w.relay, pollSec: 60 }); }
      w.reports.push(...body.events); return json({ ok: true });
    }
    return json(body.map((c) => {
      const out = (r) => ({ jsonrpc: '2.0', id: c.id, result: r });
      if (c.method === 'eth_blockNumber') return out('0x10');
      if (c.method === 'eth_getBalance') return out('0x' + hex(0.01e18));
      const d = c.params[0].data, sel = d.slice(0, 10);
      if (sel === SEL.seriesCount) return out('0x' + hex(4));
      if (sel === SEL.halted) return out('0x' + hex(0));
      if (sel === SEL.minTicket) return out('0x' + hex(1e6));
      if (sel === SEL.rfv) return out('0x' + (23_220_000n * 10n ** 18n).toString(16).padStart(64, '0'));
      if (sel === SEL.series) return out(encodeSeries(w.series));
      if (sel === SEL.balanceOf) return out('0x' + hex(c.params[0].to.toLowerCase().includes('a'.repeat(40)) ? w.tokens * 1e18 : w.usdg * 1e6));
      if (sel === SEL.allowance) return out('0x' + hex(0));
      if (sel === SEL.quoteBuy) { const usd = Number(BigInt('0x' + d.slice(74, 138))) / 1e6; return out('0x' + hex((usd / 0.55) * 1e18) + hex(0)); }
      if (sel === SEL.quoteSell) { const tk = Number(BigInt('0x' + d.slice(74, 138))) / 1e18; return out('0x' + hex(tk * 0.5 * 1e6) + hex(0)); }
      return { jsonrpc: '2.0', id: c.id, error: { message: 'unexpected ' + sel } };
    }));
  };
  return w;
}
function setup(w, settings) {
  const store = makeStore(mkdtempSync(join(tmpdir(), 'nnib-')));
  store.saveSettings({ relayToken: 'nnib_' + 'x'.repeat(40), ...settings });
  const sent = [];
  const signer = { address: '0x' + 'c'.repeat(40),
    approve: async (a) => { sent.push(['approve', a]); },
    buy: async (side, usdg, q) => { sent.push(['buy', side, usdg, q]); w.usdg -= usdg; w.tokens += Number(q) / 1e18; return { tokens: Number(q) / 1e18, tx: '0xb' }; },
    sell: async (side, tokens) => { sent.push(['sell', side, tokens]); w.tokens -= tokens; return { proceeds: tokens * 0.5, tx: '0xs' }; },
    redeem: async () => ({ proceeds: 0, tx: '0xr' }) };
  const bot = makeBot({ store, fetchImpl: w.fetch, log: () => {}, signerFactory: async () => signer });
  return { store, bot, sent };
}

test('paper: an edge buys on the curve, nothing is signed, the relay hears the fill', async () => {
  const w = world();
  const { bot, store, sent } = setup(w, { mode: 'paper', limits: { maxSpendPerSeries: 500 } });
  const p = await bot.tick({ now: NOW });
  assert.equal(p.actions[0].type, 'BUY');
  assert.equal(sent.length, 0);
  const l = store.ledger();
  assert.equal(l.tranches.length, 1); assert.equal(l.series[4].spent, 100);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(w.reports.some((e) => e.kind === 'fill' && e.act === 'BUY' && e.paper === true));
});

test('live: the desk re-quotes before signing, the desk is approved for one series budget, the fill is recorded', async () => {
  const w = world();
  const { bot, store, sent } = setup(w, { mode: 'live', limits: { maxSpendPerSeries: 300 } });
  store.saveWallet({ address: '0x' + 'c'.repeat(40), privateKey: '0x' + '1'.repeat(64), backedUp: true });
  await bot.tick({ now: NOW });
  assert.deepEqual(sent.map((s) => s[0]), ['approve', 'buy']);
  assert.equal(sent[0][1], 300); assert.equal(sent[1][2], 60);
  const t = store.ledger().tranches[0];
  assert.equal(t.status, 'OPEN'); assert.ok(Math.abs(t.tokens - 60 / 0.55) < 1e-6);
});

test('live: a price that moved away from the plan is not signed', async () => {
  const w = world({ pH: 0.6 });   // model 60%, the fake desk fills at 55¢: edge ~5¢ minus the move rule
  w.fetch = ((orig) => async (url, opts) => {
    const r = await orig(url, opts);
    if (url !== SIGNAL_URL && url !== RELAY_URL) {
      const arr = await r.json();
      for (const x of arr) if (x.result && JSON.parse(opts.body).find((c) => c.id === x.id)?.params?.[0]?.data?.startsWith(SEL.quoteBuy)) x.result = '0x' + hex((60 / 0.62) * 1e18) + hex(0);
      return { ok: true, status: 200, json: async () => arr };
    }
    return r;
  })(w.fetch);
  const { bot, store, sent } = setup(w, { mode: 'live', limits: { maxSpendPerSeries: 300 } });
  store.saveWallet({ address: '0x' + 'c'.repeat(40), privateKey: '0x' + '1'.repeat(64), backedUp: true });
  const p = await bot.tick({ now: NOW });
  assert.ok(p.actions.some((a) => a.type === 'BUY'));
  assert.equal(sent.filter((s) => s[0] === 'buy').length, 0);
  assert.ok(store.log().some((e) => /price moved/.test(e.text || '')));
});

test('Telegram: stop sends nothing, sell-all sells and stops, resume clears the loss stops', async () => {
  const w = world();
  const { bot, store, sent } = setup(w, { mode: 'live', limits: { maxSpendPerSeries: 300 } });
  store.saveWallet({ address: '0x' + 'c'.repeat(40), privateKey: '0x' + '1'.repeat(64), backedUp: true });
  await bot.tick({ now: NOW });
  assert.equal(store.ledger().tranches.length, 1);
  w.relay.stop = true;
  sent.length = 0;
  await bot.tick({ now: NOW + 3600e3 });
  assert.equal(sent.length, 0);
  w.relay.flattenSeq = 1;
  await bot.tick({ now: NOW + 3600e3 + 61e3 });
  assert.deepEqual(sent.map((s) => s[0]), ['sell']);
  const l = store.ledger();
  assert.equal(l.tranches[0].status, 'CLOSED'); assert.equal(l.seen.flattenSeq, 1);
  l.lossStop = { tripped: true }; store.saveLedger(l);
  w.relay = { stop: false, flattenSeq: 1, resetSeq: 1 };
  await bot.tick({ now: NOW + 7200e3 });
  assert.equal(store.ledger().lossStop.tripped, false);
  await new Promise((r) => setTimeout(r, 20));
  const codes = w.reports.filter((e) => e.kind === 'notice').map((e) => e.code);
  for (const c of ['stopped', 'sold-all', 'reset']) assert.ok(codes.includes(c), c + ' in ' + codes);
});

test('nothing reported carries a key or the recovery phrase', async () => {
  const w = world();
  const { bot, store } = setup(w, { mode: 'live', limits: { maxSpendPerSeries: 300 } });
  store.saveWallet({ address: '0x' + 'c'.repeat(40), privateKey: '0x' + '1'.repeat(64), phrase: 'alpha bravo charlie', backedUp: true });
  await bot.tick({ now: NOW });
  await new Promise((r) => setTimeout(r, 20));
  const all = JSON.stringify(w.reports);
  assert.ok(!all.includes('1'.repeat(64)) && !all.includes('alpha bravo'));
});
