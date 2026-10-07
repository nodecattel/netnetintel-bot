// The bot's decisions, with no side effects: given the ledger, a fresh chain read, the site's signal and the owner's
// settings, return what to do this tick. The executor (trader.mjs) signs and records; the tests run this directly.
//
// Order of authority:
//   1. the owner     kill switch (Telegram /stop or the local page) stops every transaction; "sell all" sells
//   2. the chain     the desk's own series, prices, balances and quotes — never the signal's copy of them
//   3. the signal    netnetintel.com's model and pre-trade checks, only once it agrees with the chain
//   4. the strategy  the site's own rules (vendor/strategy.mjs: planTick, the same code the paper bot and backtest run)
//   5. the limits    max spend per series, largest ticket, loss stops, reserve, gas — applied last, they only shrink
import { BOT_CONFIG, planTick, settlement, isTradable, paperAdjustedSeries, paperSell, paperBuy } from './vendor/strategy.mjs';
import { DEFAULT_LIMITS, DEFAULT_CHECKS, GAS_FLOOR_ETH } from './constants.mjs';

export const emptyLedger = (mode = 'paper') => ({
  v: 1, mode, tranches: [], series: {}, lossStop: { tripped: false, reason: null, at: null }, realizedSinceReset: 0,
  seen: { flattenSeq: 0, resetSeq: 0 }, stop: { local: false }, lastTick: null, nextId: 1
});
export const openTranches = (st) => (st.tranches || []).filter((t) => t.status === 'OPEN');
export const seriesBook = (st, id) => (st.series[id] ||= { spent: 0, realized: 0, lossStop: false });

// The owner's limits with their defaults filled in (null where the budget is missing: nothing trades).
export function limitsOf(settings) {
  const l = { ...DEFAULT_LIMITS, ...(settings?.limits || {}) };
  const budget = Number(l.maxSpendPerSeries) > 0 ? Number(l.maxSpendPerSeries) : null;
  const pos = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
  return {
    maxSpendPerSeries: budget,
    maxTicket: budget == null ? null : Math.min(budget, pos(l.maxTicket, budget * BOT_CONFIG.initialPct)),
    lossStopSeries: budget == null ? null : pos(l.lossStopSeries, budget / 2),
    lossStopTotal: budget == null ? null : pos(l.lossStopTotal, budget),
    reserveUsdg: Math.max(0, Number(l.reserveUsdg) || 0)
  };
}
export const checksOf = (settings) => ({ ...DEFAULT_CHECKS, ...(settings?.checks || {}) });
export function strategyOf(settings, limits) {
  const s = { ...BOT_CONFIG, ...(settings?.strategy || {}) };
  if (limits.maxSpendPerSeries != null) s.fundUsdg = limits.maxSpendPerSeries;
  // the first ticket follows the owner's largest ticket
  if (limits.maxTicket != null && s.fundUsdg > 0) s.initialPct = Math.min(1, limits.maxTicket / s.fundUsdg);
  s.addSpendUsdg = Math.min(s.addSpendUsdg, limits.maxTicket ?? s.addSpendUsdg);
  return s;
}

// The signal is only used once it describes the same market the chain shows.
export function verifySignal(sig, view, checks, now) {
  const problems = [];
  const cur = view?.cur;
  if (!sig) problems.push('the signal could not be read');
  else {
    const sc = sig.market?.current;
    if (!cur) problems.push('no live series on chain');
    else if (!sc) problems.push('the signal has no live series');
    else {
      if (Number(sc.seriesId) !== Number(cur.seriesId)) problems.push(`the signal is on series #${sc.seriesId}, the chain on #${cur.seriesId}`);
      if (!(Math.abs(Number(sc.line) - cur.line) <= Math.max(1, cur.line * 1e-9))) problems.push('the signal\'s line differs from the chain\'s');
    }
    if (!sig.model) problems.push('the signal has no model');
    else {
      if (!(sig.model.pH >= 0 && sig.model.pH <= 1)) problems.push('the model\'s odds are not a probability');
      if (cur && sig.model.line != null && !(Math.abs(sig.model.line - cur.line) <= Math.max(1, cur.line * 1e-9))) problems.push('the model was fitted to another line');
    }
    const ts = Number(sig.number?.timestamp) || 0;
    if (!ts || now - ts > checks.maxSignalAgeMin * 60e3) problems.push(`the signal's number is ${ts ? Math.round((now - ts) / 60e3) + ' min' : 'not'} recent`);
    if (checks.requireRfvMatch) {
      const a = Number(sig.number?.rfv), b = Number(view?.rfv);
      if (!(a > 0) || !(b > 0)) problems.push('Treasury.rfv() could not be compared with the chain');
      else if (Math.abs(a - b) / b * 100 > checks.rfvTolerancePct) problems.push(`the signal's Treasury.rfv() is ${((a - b) / b * 100).toFixed(2)}% off the chain's`);
    }
    if (checks.requireHealth) {
      if (!sig.health) problems.push('the site\'s pre-trade checks are missing');
    }
  }
  return { ok: problems.length === 0, problems };
}

// Open marks: what each open tranche would sell for now (the desk's own quote when live, the curve on paper).
export function marksFor(st, view) {
  const marks = {};
  const open = openTranches(st);
  if (st.mode === 'live') { for (const t of open) if (view.marks?.[t.id] != null) marks[t.id] = view.marks[t.id]; return marks; }
  const cur = view.cur;
  if (!cur) return marks;
  const adj = paperAdjustedSeries(cur, open);
  for (const t of open) if (t.seriesId === cur.seriesId) { const f = paperSell({ adj, side: t.side, tokens: t.tokens }); if (f) marks[t.id] = f.proceeds; }
  return marks;
}
// Profit and loss on one series (realized + open marks − open cost) and overall since the last reset.
export function pnl(st, marks) {
  const by = {};
  for (const [id, b] of Object.entries(st.series || {})) by[id] = { realized: b.realized || 0, open: 0, cost: 0, unmarked: 0 };
  for (const t of openTranches(st)) {
    const b = (by[t.seriesId] ||= { realized: 0, open: 0, cost: 0, unmarked: 0 });
    b.cost += t.costUsdg;
    if (marks[t.id] != null) b.open += marks[t.id]; else { b.open += t.costUsdg; b.unmarked++; }   // no quote: carried at cost
  }
  let openPnl = 0;
  for (const b of Object.values(by)) { b.total = b.realized + b.open - b.cost; openPnl += b.open - b.cost; }
  return { bySeries: by, total: (st.realizedSinceReset || 0) + openPnl };
}

// One tick. control: { stopped, flatten } from Telegram and the local page.
// Returns { actions, decision, verify, blocks, latch, pnl } — actions in order: REDEEM, SELL, BUY.
export function plan({ st, view, sig, settings, control = {}, now = Date.now() }) {
  const limits = limitsOf(settings), checks = checksOf(settings), config = strategyOf(settings, limits);
  const live = st.mode === 'live';
  const verify = verifySignal(sig, view, checks, now);
  const marks = marksFor(st, view);
  const pl = pnl(st, marks);
  const out = { actions: [], decision: null, verify, blocks: [], latch: { series: null, total: null }, pnl: pl, limits };
  const open = openTranches(st);

  // 1. the owner's kill switch
  if (control.flatten) {
    for (const t of open) {
      const s = view.bySeries?.[t.seriesId];
      if (s && settlement(s)) out.actions.push(redeemAction(st, s, [t], live));
      else if (view.cur && t.seriesId === view.cur.seriesId && view.cur.sellsOpen) out.actions.push({ type: 'SELL', tranche: t, reason: 'sell all (owner asked)', fill: live ? null : paperFill(view, open, t) });
    }
    out.decision = 'selling everything the bot holds, then stopping';
    return mergeRedeems(out);
  }
  if (control.stopped) { out.decision = 'stopped by the owner — no transactions until resumed'; return out; }

  // 2. the strategy, on the chain's series and the verified signal
  const siteHealth = checks.requireHealth ? sig?.health : null;
  const blockEntries = !verify.ok || !!siteHealth?.blockEntries;
  const holdStops = !verify.ok || !!siteHealth?.holdStops;
  const reason = [!verify.ok ? 'signal: ' + verify.problems.join('; ') : '', siteHealth?.blockEntries ? siteHealth.reason : ''].filter(Boolean).join(' · ');
  const model = verify.ok ? sig.model : null;   // an unverified model is not traded on — take-profit still runs on the desk's quotes
  const p = planTick({
    bets: open, desk: { bySeries: view.bySeries || {}, halted: !!view.halted }, cur: view.cur, model, config,
    live, health: { blockEntries, holdStops, reason }, now, markOf: (b) => marks[b.id] ?? null
  });

  for (const x of p.settles) out.actions.push(redeemAction(st, view.bySeries[x.bet.seriesId], [x.bet], live));
  for (const c of p.closes) out.actions.push({ type: 'SELL', tranche: c.bet, reason: c.reason, fill: c.fill || null });
  out.decision = p.decision?.reason || null;
  mergeRedeems(out);

  // 3. the limits — they only ever shrink or stop an entry
  const cur = view.cur;
  if (cur) {
    const b = st.series?.[cur.seriesId] || { spent: 0, realized: 0, lossStop: false };
    const sp = pl.bySeries[cur.seriesId];
    if (limits.lossStopSeries != null && sp && sp.total <= -limits.lossStopSeries && !b.lossStop) out.latch.series = { seriesId: cur.seriesId, loss: sp.total };
    if (limits.lossStopTotal != null && pl.total <= -limits.lossStopTotal && !st.lossStop?.tripped) out.latch.total = { loss: pl.total };
  }
  const e = p.entry;
  if (!e) return out;
  const b = st.series?.[cur.seriesId] || { spent: 0 };
  const block = (why) => { out.blocks.push(why); return out; };
  if (limits.maxSpendPerSeries == null) return block('no series budget set');
  if (st.lossStop?.tripped || out.latch.total) return block('loss stop: down ' + money(-pl.total) + ' since the last reset (limit ' + money(limits.lossStopTotal) + ')');
  if (b.lossStop || out.latch.series) return block('series loss stop: #' + cur.seriesId + ' is down ' + money(-(pl.bySeries[cur.seriesId]?.total ?? 0)));
  const room = limits.maxSpendPerSeries - (b.spent || 0);
  let spend = Math.min(e.spend, room, limits.maxTicket);
  if (live) {
    if (!(view.eth >= GAS_FLOOR_ETH)) return block('not enough ETH for gas');
    spend = Math.min(spend, (view.usdg ?? 0) - limits.reserveUsdg);
  }
  spend = Math.floor(spend * 100) / 100;
  const minT = Math.max(1, view.minTicket || 0);
  if (!(spend >= minT)) return block(room < minT ? `series budget used (${money(b.spent)} of ${money(limits.maxSpendPerSeries)})` : live && (view.usdg ?? 0) - limits.reserveUsdg < minT ? 'not enough USDG in the wallet' : `ticket below the desk's minimum ${money(minT)}`);
  const fill = live ? null : paperBuy({ adj: paperAdjustedSeries(cur, openTranches(st)), side: e.side, spendUsdg: spend });
  if (!live && !(fill?.tokens > 0)) return block('no paper fill');
  out.actions.push({ type: 'BUY', kind: e.kind, side: e.side, seriesId: cur.seriesId, spend, modelP: e.modelP, edgeCents: e.edgeCents, reason: e.reason, fill,
    minEdgeCents: e.kind === 'OPEN' ? config.minEdgeCents : config.addEdgeCents });
  return out;
}

function paperFill(view, open, t) {
  return paperSell({ adj: paperAdjustedSeries(view.cur, open), side: t.side, tokens: t.tokens });
}
function redeemAction(st, s, tranches, live) {
  const set = settlement(s);
  const t = tranches[0];
  const tokens = tranches.reduce((a, x) => a + x.tokens, 0);
  return { type: 'REDEEM', seriesId: t.seriesId, side: t.side, tranches, tokens, payout: tokens * set.payout(t.side), won: set.voided ? null : t.side === set.winner, voided: set.voided };
}
// one redeem per series and side
function mergeRedeems(out) {
  const merged = [], idx = {};
  for (const a of out.actions) {
    if (a.type !== 'REDEEM') { merged.push(a); continue; }
    const k = a.seriesId + ':' + a.side;
    if (idx[k] == null) { idx[k] = merged.length; merged.push({ ...a, tranches: [...a.tranches] }); continue; }
    const m = merged[idx[k]];
    m.tranches.push(...a.tranches); m.tokens += a.tokens; m.payout += a.payout;
  }
  const order = { REDEEM: 0, SELL: 1, BUY: 2 };
  out.actions = merged.sort((a, b) => order[a.type] - order[b.type]);
  return out;
}

// Live: the chain's balances are the truth. A position the owner sold by hand shrinks the bot's tranches to match.
export function reconcile(st, view) {
  const notes = [];
  if (st.mode !== 'live') return notes;
  const groups = {};
  for (const t of openTranches(st)) (groups[t.seriesId + ':' + t.side] ||= []).push(t);
  for (const [k, ts] of Object.entries(groups)) {
    const [id, side] = k.split(':');
    const have = view.held?.[id]?.[side];
    if (have == null) continue;
    const want = ts.reduce((a, t) => a + t.tokens, 0);
    if (have >= want * (1 - 1e-9) - 1e-12) continue;
    const f = Math.max(0, have / want);
    for (const t of ts) { t.tokens *= f; t.costUsdg *= f; if (t.tokens < 1e-9) { t.status = 'GONE'; t.closedAt = Date.now(); } }
    notes.push(`#${id} ${side}: the wallet holds ${have.toFixed(3)} tokens, the bot's record ${want.toFixed(3)} — matched to the wallet`);
  }
  return notes;
}

export const money = (v) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(2));
export { isTradable };
