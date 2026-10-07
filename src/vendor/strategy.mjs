// GENERATED from the NetNet Intel site's strategy code (predictStrategy.ts, predictTicket.ts) by tools/selfhost-vendor.mjs.
// Do not edit here: the site's paper bot, its backtest and this bot run the same rules.
// base44/shared/predictStrategy.ts
var SKEW_CAP = 0.35;
var BOT_CONFIG = {
  fundUsdg: 1e3,
  // paper bankroll the bot may deploy per series
  initialPct: 0.2,
  // first ticket = 20% of the fund
  addSpendUsdg: 100,
  // each DCA-in tranche
  minEdgeCents: 5,
  // open only when model P beats the after-fee price by ≥5¢
  addEdgeCents: 10,
  // DCA-in bar — edge must be wider than the open bar
  dipPctToAdd: 0.05,
  // average down when the side price is ≥5% below our avg entry
  takeProfitPct: 0.5,
  // scale out: realize a tranche once it is ≥50% in profit
  closeEdgeCents: -3,
  // exit a tranche when its edge falls below −3¢
  minDailyPoints: 4,
  // model history requirement
  minModelP: 0.03,
  // never act on an extreme (overconfident) model
  maxModelP: 0.97,
  // replayed on series #1–#3 and the 6 Oct incident (tests/predict-guard): 40¢ blocks every incident entry (gaps of
  // 45–49¢) and keeps the real edges of #1–#3 (25¢ cut series #1's in half); 4 adds an hour apart keep ~60% of the
  // unguarded profit at ~60% of the exposure, where unlimited 30-minute adds put the whole fund on one reading
  maxGapCents: 40,
  // model vs market wider than this: suspect our data, stand aside (tradeGuard.ts)
  maxAdds: 4,
  // adds per series after the first ticket — no pyramiding on one signal
  minAddGapHours: 1
  // between two entries on a series
};
var priceAt = (q, a) => (1 + q / Math.sqrt(a * a + q * q)) / 2;
function feeRate(ratio, addsSkew) {
  const t = Math.min(1, Math.max(0, ratio / SKEW_CAP));
  return addsSkew ? 0.03 + 0.03 * t : 0.03 - 0.015 * t;
}
function decodeSeries(hex) {
  if (!hex || hex === "0x" || hex.length < 2 + 26 * 64) return null;
  const w = hex.slice(2).match(/.{64}/g);
  const big = (i) => BigInt("0x" + w[i]);
  const u = (i) => Number(big(i));
  const addr = (i) => "0x" + w[i].slice(-40);
  return {
    statusRaw: u(0),
    // trading runs to lastCallTime; last call to closeTime (the board and the closest guess close); the print at printTime
    openTime: u(1),
    lastCallTime: u(2),
    closeTime: u(3),
    printTime: u(4),
    gradedAt: u(5) || null,
    openNumber: u(6) / 1e12,
    line: u(7) / 1e12,
    lineRaw: big(7).toString(),
    higherToken: addr(8),
    lowerToken: addr(9),
    higherOut: u(10) / 1e18,
    lowerOut: u(11) / 1e18,
    bookUsdg: u(12) / 1e6,
    virtualLiquidity: u(13) / 1e6,
    backing: u(14) / 1e6,
    volume: u(15) / 1e6,
    feesTotal: u(16) / 1e6,
    netSpent: u(17) / 1e6,
    vaultFees: u(18) / 1e6,
    lastPrice: u(19) / 1e18,
    printNumber: u(20) > 0 ? u(20) / 1e12 : null,
    printRaw: big(20) > 0n ? big(20).toString() : null,
    // what one HIGHER token redeems for once settled (USDG; LOWER gets 1 − this): 1 or 0 when graded, the book's last
    // mark when voided
    longPayout: u(21) / 1e6,
    prizePot: u(22) / 1e6,
    prizePaid: u(23) === 1,
    bestGuesser: u(24) ? addr(24) : null,
    guessCount: u(25)
  };
}
var VOID_AFTER_S = 72 * 3600;
function marketPhase(m, now = Date.now()) {
  const t = now / 1e3;
  if (m.statusRaw === 3) return "VOIDED";
  if (m.statusRaw === 2 || m.statusRaw == null && m.gradedAt) return "SETTLED";
  if (!m.statusRaw || t < m.openTime) return "PRE-OPEN";
  if (m.statusRaw !== 1) return "UNKNOWN";
  if (t < (m.lastCallTime ?? m.closeTime - 7200)) return "TRADING";
  if (t < m.closeTime) return "LAST CALL";
  if (t < m.printTime) return "REVEAL";
  return t >= m.printTime + VOID_AFTER_S ? "VOIDABLE" : "AWAITING GRADE";
}
var isSettled = (phase) => phase === "SETTLED" || phase === "VOIDED";
var isTradable = (phase) => phase === "TRADING" || phase === "LAST CALL";
function settlement(s) {
  if (!s) return null;
  const voided = s.statusRaw === 3;
  let payH;
  if (voided || s.statusRaw === 2 && s.longPayout != null) payH = s.longPayout ?? 0;
  else if (s.statusRaw == null || s.statusRaw === 2) {
    if (s.printNumber == null) return null;
    const above = s.printRaw != null && s.lineRaw != null ? BigInt(s.printRaw) > BigInt(s.lineRaw) : s.printNumber > s.line;
    payH = above ? 1 : 0;
  } else return null;
  const winner = voided ? null : payH >= 1 ? "HIGHER" : payH <= 0 ? "LOWER" : null;
  return { voided, winner, payHigher: payH, payLower: 1 - payH, payout: (side) => side === "HIGHER" ? payH : 1 - payH };
}
function deriveSeries(cur, now = Date.now()) {
  const q = cur.higherOut - cur.lowerOut;
  const a = 0.6 * cur.backing;
  const pH = a > 0 ? priceAt(q, a) : null;
  const skewRatio = cur.backing > 0 ? Math.abs(q) / cur.backing : 0;
  const phase = marketPhase(cur, now);
  const buysClosed = !!cur.halted || !isTradable(phase);
  const side = (name) => {
    const price = name === "HIGHER" ? pH : pH == null ? null : 1 - pH;
    const addsSkew = name === "HIGHER" ? q > 0 : q < 0;
    const fee = feeRate(skewRatio, addsSkew);
    const reduces = name === "HIGHER" ? q < 0 : q > 0;
    const open = buysClosed ? false : phase === "LAST CALL" ? reduces : !addsSkew || skewRatio < SKEW_CAP;
    return { price, fee, open, addsSkew, breakEven: price != null ? price * (1 + fee) : null };
  };
  return {
    ...cur,
    asOf: now,
    phase,
    q,
    a,
    skewRatio,
    capHit: skewRatio >= SKEW_CAP,
    buysOpen: !buysClosed,
    sellsOpen: isTradable(phase),
    heavy: q >= 0 ? "HIGHER" : "LOWER",
    priceHigher: pH,
    higher: side("HIGHER"),
    lower: side("LOWER")
  };
}
function decide({ series, model, halted, config = BOT_CONFIG }) {
  if (halted) return { action: "NONE", reason: "desk halted" };
  if (!series || !series.line) return { action: "NONE", reason: "no live series" };
  if (series.phase !== "TRADING") return { action: "NONE", reason: "phase " + series.phase };
  if (!model) return { action: "NONE", reason: "no model" };
  if (model.dailyPoints < config.minDailyPoints) return { action: "NONE", reason: "history thin (" + model.dailyPoints + " daily pts)" };
  const cands = [];
  for (const [side, modelP, s] of [["HIGHER", model.pH, series.higher], ["LOWER", model.pL, series.lower]]) {
    if (modelP == null || !s || s.price == null || s.breakEven == null) continue;
    cands.push({ side, modelP, s, edgeCents: (modelP - s.breakEven) * 100 });
  }
  if (!cands.length) return { action: "NONE", reason: "no price" };
  cands.sort((a, b) => b.edgeCents - a.edgeCents);
  const blocked = [];
  for (const c of cands) {
    if (c.modelP < config.minModelP || c.modelP > config.maxModelP) {
      blocked.push(c.side + " model extreme (" + (c.modelP * 100).toFixed(0) + "%)");
    } else if (config.maxGapCents != null && Math.abs(c.modelP - c.s.price) * 100 > config.maxGapCents) {
      blocked.push(c.side + " model " + (c.modelP * 100).toFixed(0) + "% vs market " + (c.s.price * 100).toFixed(0) + "\xA2 \u2014 too wide to trust");
    } else if (!c.s.open) {
      blocked.push(c.side + " buys shut at the skew cap");
    } else if (c.edgeCents < config.minEdgeCents) {
      blocked.push(c.side + " edge " + c.edgeCents.toFixed(1) + "c < " + config.minEdgeCents + "c");
    } else {
      return { action: "OPEN", side: c.side, modelP: c.modelP, edgeCents: c.edgeCents, reason: "edge " + c.edgeCents.toFixed(1) + "c on " + c.side };
    }
  }
  return { action: "NONE", reason: blocked.join(" \xB7 "), edgeCents: cands[0].edgeCents };
}
function exitDecision({ bet, series, model, markUsdg, config = BOT_CONFIG }) {
  if (!series || series.phase !== "TRADING" && series.phase !== "LAST CALL")
    return { action: "NONE", reason: "not tradable" };
  const s = bet.side === "HIGHER" ? series.higher : series.lower;
  if (!s || s.price == null) return { action: "NONE", reason: "no live price" };
  const cost = bet.costUsdg ?? bet.spendUsdg ?? 0;
  if (markUsdg != null && cost > 0 && markUsdg >= cost * (1 + config.takeProfitPct)) {
    const gain = (markUsdg / cost - 1) * 100;
    return { action: "CLOSE", reason: "take-profit +" + gain.toFixed(0) + "% locked" };
  }
  const modelP = bet.side === "HIGHER" ? model ? model.pH : null : model ? model.pL : null;
  if (modelP == null) return { action: "NONE", reason: "no live model" };
  const edgeCents = (modelP - s.price) * 100;
  if (edgeCents < config.closeEdgeCents)
    return { action: "CLOSE", reason: "edge fell to " + edgeCents.toFixed(1) + "c", edgeCents };
  return { action: "NONE", reason: "holding, edge " + edgeCents.toFixed(1) + "c", edgeCents };
}
var solveQ = (c, a) => 2 * c * (c + a) / (2 * c + a);
var costC = (q, a) => q / 2 + (Math.sqrt(a * a + q * q) - a) / 2;
function quoteBuy(q, a, spend, side) {
  if (!(spend > 0) || !(a > 0)) return { tokens: 0, avg: null };
  const s = side === "HIGHER" ? q : -q;
  const q2 = solveQ(costC(s, a) + spend, a);
  const tokens = Math.abs(q2 - s);
  return { tokens, avg: tokens > 0 ? spend / tokens : null };
}
function quoteSell(q, a, tokens, side) {
  if (!(tokens > 0) || !(a > 0)) return 0;
  const s = side === "HIGHER" ? q : -q;
  return costC(s, a) - costC(s - tokens, a);
}
function paperAdjustedSeries(cur, openBets) {
  const held = (openBets || []).filter((b) => b.seriesId === cur.seriesId && b.status === "OPEN");
  if (!held.length || !cur.backing) return cur;
  let higherTok = 0, lowerTok = 0;
  for (const b of held) {
    if (b.side === "HIGHER") higherTok += b.tokens || 0;
    else lowerTok += b.tokens || 0;
  }
  return deriveSeries({
    ...cur,
    higherOut: cur.higherOut + higherTok,
    lowerOut: cur.lowerOut + lowerTok
  }, cur.asOf ?? Date.now());
}
function paperBuy({ adj, side, spendUsdg }) {
  const s = side === "HIGHER" ? adj.higher : adj.lower;
  if (!s || s.price == null || !(spendUsdg > 0) || !(adj.a > 0)) return null;
  const feeUsdg = spendUsdg * s.fee;
  const { tokens } = quoteBuy(adj.q, adj.a, spendUsdg - feeUsdg, side);
  return tokens > 0 ? { tokens, feeUsdg, avg: spendUsdg / tokens } : null;
}
function paperSell({ adj, side, tokens }) {
  if (!(tokens > 0) || !(adj.a > 0)) return null;
  const sellAddsSkew = side === "HIGHER" ? adj.q < 0 : adj.q > 0;
  const fee = feeRate(adj.skewRatio, sellAddsSkew);
  const pre = quoteSell(adj.q, adj.a, tokens, side);
  if (!(pre > 0)) return null;
  const proceeds = pre * (1 - fee);
  return { proceeds, feeUsdg: pre * fee, closePrice: proceeds / tokens };
}
function dcaInDecision({ openBets, series, model, config = BOT_CONFIG, now = Date.now() }) {
  const held = (openBets || []).filter((b) => b.seriesId === series.seriesId && b.status === "OPEN");
  if (!held.length) return { action: "NONE", reason: "no existing position" };
  if (series.halted) return { action: "NONE", reason: "desk halted (buys only)" };
  if (series.phase !== "TRADING") return { action: "NONE", reason: "phase " + series.phase };
  if (!model) return { action: "NONE", reason: "no model" };
  const side = held[0].side;
  const modelP = side === "HIGHER" ? model.pH : model.pL;
  const s = side === "HIGHER" ? series.higher : series.lower;
  if (s.price == null || s.breakEven == null) return { action: "NONE", reason: "no price" };
  if (!s.open) return { action: "NONE", reason: side + " buys shut at skew cap" };
  if (modelP < config.minModelP || modelP > config.maxModelP)
    return { action: "NONE", reason: "model extreme (" + (modelP * 100).toFixed(0) + "%)" };
  if (config.maxAdds != null && held.length - 1 >= config.maxAdds)
    return { action: "NONE", reason: "adds capped (" + config.maxAdds + " per series)" };
  const lastAt = Math.max(...held.map((b) => b.openedAt ?? (b.created_date ? Date.parse(b.created_date.endsWith("Z") ? b.created_date : b.created_date + "Z") : 0)));
  if (config.minAddGapHours != null && lastAt > 0 && now - lastAt < config.minAddGapHours * 36e5)
    return { action: "NONE", reason: "last entry " + Math.round((now - lastAt) / 6e4) + " min ago \u2014 adds spaced " + config.minAddGapHours + "h" };
  if (config.maxGapCents != null && Math.abs(modelP - s.price) * 100 > config.maxGapCents)
    return { action: "NONE", reason: "model " + (modelP * 100).toFixed(0) + "% vs market " + (s.price * 100).toFixed(0) + "\xA2 \u2014 too wide to trust" };
  const tokSum = held.reduce((sum, b) => sum + (b.tokens || 0), 0) || 1;
  const avgEntry = held.reduce((sum, b) => sum + (b.avgPrice || 0) * (b.tokens || 0), 0) / tokSum;
  const edgeCents = (modelP - s.breakEven) * 100;
  const dipPct = avgEntry > 0 ? (avgEntry - s.price) / avgEntry : 0;
  if (edgeCents < config.addEdgeCents)
    return { action: "NONE", reason: "add-edge " + edgeCents.toFixed(1) + "c < " + config.addEdgeCents + "c" };
  if (dipPct < config.dipPctToAdd && edgeCents < 2 * config.addEdgeCents)
    return { action: "NONE", reason: "no dip vs avg entry " + (avgEntry * 100).toFixed(1) + "c, edge below conviction bar" };
  return {
    action: "ADD",
    side,
    modelP,
    edgeCents,
    dipPct,
    avgEntry,
    reason: "dca-in: edge " + edgeCents.toFixed(1) + "c, price " + (dipPct >= 0 ? "-" : "+") + Math.abs(dipPct * 100).toFixed(1) + "% vs avg entry " + (avgEntry * 100).toFixed(1) + "c"
  };
}
function planTick({ bets, desk, cur, model, config = BOT_CONFIG, watchReview = false, live = false, health = null, now = Date.now(), markOf = null }) {
  const open = (bets || []).filter((b) => b && b.status === "OPEN" && !b.archived);
  const settles = [];
  for (const bet of open) {
    const st = settlement(desk?.bySeries?.[bet.seriesId]);
    if (!st) continue;
    const s = desk.bySeries[bet.seriesId];
    const payout = bet.tokens * st.payout(bet.side), won = st.voided ? null : bet.side === st.winner;
    settles.push({ bet, won, wonSide: st.winner, voided: st.voided, printNumber: s.printNumber, payout, pnl: payout - (bet.costUsdg ?? bet.spendUsdg ?? 0) });
  }
  const settledIds = new Set(settles.map((x) => x.bet));
  const stillOpen = open.filter((b) => !settledIds.has(b));
  if (!cur) return { settles, closes: [], entry: null, decision: { action: "NONE", reason: "no live series" }, adj: null, deployed: 0, remaining: config.fundUsdg };
  const adj = live ? cur : paperAdjustedSeries(cur, stillOpen);
  const closes = [];
  for (const bet of stillOpen) {
    if (bet.seriesId !== cur.seriesId) continue;
    const fill = live ? null : paperSell({ adj, side: bet.side, tokens: bet.tokens });
    const mark = live ? markOf ? markOf(bet) : null : fill ? fill.proceeds : null;
    const xd = exitDecision({ bet, series: adj, model, markUsdg: mark, config });
    if (xd.action !== "CLOSE") continue;
    if (health?.holdStops && !/^take-profit/.test(xd.reason)) continue;
    if (!live && !fill) continue;
    closes.push({ bet, fill, mark, reason: xd.reason });
  }
  const openOnSeries = stillOpen.filter((b) => b.seriesId === cur.seriesId);
  const deployed = openOnSeries.reduce((s, b) => s + (b.spendUsdg || 0), 0);
  const remaining = config.fundUsdg - deployed;
  const entryFill = (side, spend) => live ? null : paperBuy({ adj, side, spendUsdg: spend });
  let decision, entry = null;
  if (watchReview) {
    decision = { action: "NONE", reason: "official app sleeve code changed \u2014 standing aside until reviewed" };
  } else if (health?.blockEntries) {
    decision = { action: "NONE", reason: "health check: " + health.reason, guard: true };
  } else if (!openOnSeries.length) {
    decision = decide({ series: adj, model, halted: desk?.halted, config });
    if (decision.action === "OPEN" && remaining > 0) {
      const spend = Math.min(config.initialPct * config.fundUsdg, remaining);
      const fill = entryFill(decision.side, spend);
      if (live || fill && fill.tokens > 0) {
        entry = {
          kind: "OPEN",
          side: decision.side,
          spend,
          fill,
          modelP: decision.modelP,
          edgeCents: decision.edgeCents,
          reason: `first ticket (${Math.round(config.initialPct * 100)}% of fund) \u2014 ${decision.reason}`
        };
      } else decision = { action: "NONE", reason: "fill unavailable" };
    }
  } else if (remaining >= Math.min(config.addSpendUsdg, 25)) {
    const ca = dcaInDecision({ openBets: stillOpen, series: adj, model, config, now });
    decision = { action: ca.action, reason: ca.reason, edgeCents: ca.edgeCents ?? null };
    if (ca.action === "ADD") {
      const spend = Math.min(config.addSpendUsdg, remaining);
      const fill = entryFill(ca.side, spend);
      if (live || fill && fill.tokens > 0) entry = { kind: "ADD", side: ca.side, spend, fill, modelP: ca.modelP, edgeCents: ca.edgeCents, reason: ca.reason };
      else decision = { action: "NONE", reason: "fill unavailable" };
    }
  } else {
    decision = { action: "NONE", reason: "fund fully deployed (" + deployed + "/" + config.fundUsdg + ")" };
  }
  return { settles, closes, entry, decision, adj, deployed, remaining, openOnSeries };
}

// base44/shared/predictTicket.ts
var PREDICT_DESK = "0x7EF9528408D99f98056922291048F0710001e015";
var USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
var SEL = {
  buy: "0x01a9812c",
  sell: "0xde254659",
  redeem: "0xe43f80a5",
  guess: "0x9189fec1",
  quoteBuy: "0xc7d4bc7f",
  quoteSell: "0x6d6c8295",
  feesPaid: "0x220c5cc0",
  guessOf: "0x71f10824",
  approve: "0x095ea7b3",
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e"
};
var DEFAULT_SLIPPAGE_BPS = 150;
var GAS_FLOOR_ETH = 2e-5;
function minOut(quoteRaw, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  return BigInt(quoteRaw) * BigInt(1e4 - slippageBps) / 10000n;
}
export {
  BOT_CONFIG,
  DEFAULT_SLIPPAGE_BPS,
  GAS_FLOOR_ETH,
  PREDICT_DESK,
  SEL,
  SKEW_CAP,
  USDG,
  VOID_AFTER_S,
  costC,
  dcaInDecision,
  decide,
  decodeSeries,
  deriveSeries,
  exitDecision,
  feeRate,
  isSettled,
  isTradable,
  marketPhase,
  minOut,
  paperAdjustedSeries,
  paperBuy,
  paperSell,
  planTick,
  priceAt,
  quoteBuy,
  quoteSell,
  settlement,
  solveQ
};
