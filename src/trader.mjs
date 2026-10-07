// One tick of the bot: read the chain and the signal, take the owner's commands, decide (engine.mjs), then sign and
// record each action in order. Paper mode runs the same path with fills priced on the desk's curve and no signing.
import { plan, reconcile, emptyLedger, openTranches, seriesBook, limitsOf, checksOf, money } from './engine.mjs';
import { readView, quoteBuyRaw, quoteSellRaw, makeRpc, makeSigner } from './chain.mjs';
import { SIGNAL_URL, PUBLIC_RPC, GAS_FLOOR_ETH } from './constants.mjs';
import { makeRelay, VERSION } from './relay.mjs';
import { walletOf } from './wallet.mjs';

const HOUR = 3600e3;

export function makeBot({ store, fetchImpl = fetch, log = console.log, signerFactory = makeSigner }) {
  let relay = null, relayToken = undefined, signer = null, signerKey = null;
  let lastView = null, lastPlan = null, lastError = null, running = false;
  const notices = {};   // code → last sent ms (throttle)

  const settings = () => store.settings() || {};
  function ledger() {
    const s = settings();
    let st = store.ledger();
    if (!st) { st = emptyLedger(s.mode === 'live' ? 'live' : 'paper'); store.saveLedger(st); }
    return st;
  }
  function relayFor(s) {
    const token = s.relayToken || null;
    if (!relay || token !== relayToken) { relay = makeRelay({ token, url: s.relayUrl || undefined, fetchImpl, log }); relayToken = token; }
    return relay;
  }
  function activity(entry) { const l = store.log(); l.push({ at: Date.now(), ...entry }); store.saveLog(l); }
  function notice(code, text, everyMs = HOUR) {
    const now = Date.now();
    if (notices[code] && now - notices[code] < everyMs) return;
    notices[code] = now;
    activity({ kind: 'notice', code, text });
    relay?.report({ kind: 'notice', code, text });
  }
  async function signal() {
    const s = settings();
    const res = await fetchImpl(s.signalUrl || SIGNAL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('signal HTTP ' + res.status);
    return res.json();
  }
  async function getSigner(s) {
    const wl = walletOf(store, s);
    if (!wl?.privateKey) throw new Error('no bot wallet yet');
    if (!signer || signerKey !== wl.privateKey) { signer = await signerFactory(wl.privateKey, s.rpcUrl || PUBLIC_RPC); signerKey = wl.privateKey; }
    return signer;
  }

  // the owner's switches: Telegram (via the relay) and the local page
  function controlFor(st, rc) {
    const flatten = !!st.stop?.flattenLocal || (rc && rc.flattenSeq > (st.seen?.flattenSeq || 0));
    const stopped = !!st.stop?.local || !!rc?.stop;
    return { stopped, flatten };
  }

  async function tick({ now = Date.now() } = {}) {
    if (running) return { skipped: 'busy' };
    running = true;
    try { return await tickInner(now); } catch (e) {
      lastError = e.message; log('tick: ' + e.message);
      notice('error:' + e.message.slice(0, 40), 'Tick failed: ' + e.message.slice(0, 200), 6 * HOUR);
      return { error: e.message };
    } finally { running = false; relay?.flush().catch(() => {}); }
  }

  async function tickInner(now) {
    const s = settings();
    const rl = relayFor(s);
    const st = ledger();
    const wanted = s.mode === 'live' ? 'live' : 'paper';
    if (st.mode !== wanted) {   // switching mode starts a clean ledger (paper positions are not real)
      if (wanted === 'live' && openTranches(st).length) activity({ kind: 'notice', code: 'mode', text: 'Paper positions closed out on switching to live.' });
      const fresh = emptyLedger(wanted); fresh.seen = st.seen; fresh.stop = { local: !!st.stop?.local };
      store.saveLedger(fresh);
      notice('mode', wanted === 'live' ? 'Live trading is on — real USDG, within your limits.' : 'Back to paper trading — no real transactions.', 0);
      return tickInner(now);
    }
    const limits = limitsOf(s);
    const wl = walletOf(store, s);
    const me = wl?.address || null;
    const rpc = makeRpc(s.rpcUrl || PUBLIC_RPC, fetchImpl);

    const rc = await rl.poll(statusLine(st), now);
    if (rc && rc.resetSeq > (st.seen?.resetSeq || 0)) {
      st.seen.resetSeq = rc.resetSeq;
      clearLossStops(st);
      notice('reset', 'Resumed: loss stops reset.', 0);
    }
    const control = controlFor(st, rc);
    if (control.stopped && !st._wasStopped) notice('stopped', 'Stopped. No transactions until you /resume.', 0);
    if (!control.stopped && st._wasStopped) notice('resumed', 'Running again.', 0);
    st._wasStopped = control.stopped;

    if (limits.maxSpendPerSeries == null) { lastPlan = { decision: 'set a series budget on the setup page to start', actions: [] }; store.saveLedger(st); return lastPlan; }
    if (wanted === 'live' && !me) { lastPlan = { decision: 'create the bot wallet on the setup page', actions: [] }; store.saveLedger(st); return lastPlan; }

    const [view, sig] = await Promise.all([
      readView(rpc, me, wanted === 'live' ? openTranches(st) : [], now),   // paper: the wallet's balances for the page, no quotes
      signal().catch((e) => { log('signal: ' + e.message); return null; })
    ]);
    lastView = view;
    for (const n of reconcile(st, view)) notice('reconcile', n, 0);
    if (wanted === 'live' && view.eth != null && view.eth < GAS_FLOOR_ETH) notice('gas', `The bot wallet is low on ETH for gas (${view.eth.toFixed(6)}). Send a little ETH on Robinhood Chain.`, 6 * HOUR);

    const p = plan({ st, view, sig, settings: s, control, now });
    lastPlan = p;
    if (p.latch.total) {
      st.lossStop = { tripped: true, reason: 'down ' + money(-p.latch.total.loss), at: now };
      notice('loss-stop', `Loss stop hit: down ${money(-p.latch.total.loss)} since the last reset (limit ${money(limits.lossStopTotal)}). No new buys until you /resume. Open positions are kept.`, 0);
    }
    if (p.latch.series) {
      seriesBook(st, p.latch.series.seriesId).lossStop = true;
      notice('series-loss-stop:' + p.latch.series.seriesId, `Series #${p.latch.series.seriesId} loss stop: down ${money(-p.latch.series.loss)} (limit ${money(limits.lossStopSeries)}). No more buys on this series.`, 0);
    }
    const blockKey = [...(p.verify.ok ? [] : p.verify.problems), ...(sig?.health?.blockEntries ? [sig.health.reason] : [])].join(' | ');
    if (blockKey && !control.stopped) notice('blocked:' + blockKey.slice(0, 60), 'Not buying: ' + blockKey.slice(0, 400), 3 * HOUR);
    if (!blockKey && st._blocked) notice('unblocked', 'Checks clear again.', 0);
    st._blocked = !!blockKey;

    for (const a of p.actions) {
      try { await execute(st, a, view, s, rpc, limits, now); }
      catch (e) {
        activity({ kind: 'error', text: `${a.type} failed: ${e.message}` });
        notice('fail:' + a.type, `${a.type === 'BUY' ? 'Buy' : a.type === 'SELL' ? 'Sell' : 'Redeem'} not done: ${e.message.slice(0, 200)}`, HOUR);
        if (a.type !== 'BUY') break;   // a failed exit stops the tick; the next tick re-reads the chain
      }
    }
    if (control.flatten) {
      st.stop = { ...st.stop, local: !!st.stop?.local || !!st.stop?.flattenLocal, flattenLocal: false };
      if (rc) st.seen.flattenSeq = rc.flattenSeq;
      if (!openTranches(st).some((t) => view.bySeries?.[t.seriesId] && view.cur?.sellsOpen)) notice('sold-all', 'Sell-all done. The bot is stopped.', 0);
    }
    st.lastTick = { at: now, decision: p.decision, blocks: p.blocks, verify: p.verify, series: view.cur?.seriesId ?? null, phase: view.cur?.phase ?? null };
    store.saveLedger(st);
    lastError = null;
    return p;
  }

  async function execute(st, a, view, s, rpc, limits, now) {
    const live = st.mode === 'live';
    if (a.type === 'REDEEM') {
      let proceeds = a.payout, tx = null;
      if (live) {
        const held = view.held?.[a.seriesId]?.[a.side] ?? a.tokens;
        const r = await (await getSigner(s)).redeem(a.seriesId, a.side, Math.min(a.tokens, held));
        proceeds = r.proceeds; tx = r.tx;
      }
      closeTranches(st, a.tranches, proceeds, now, a.voided ? 'voided' : a.won ? 'won' : 'lost', 'SETTLED');
      fill(st, { act: 'REDEEM', seriesId: a.seriesId, side: a.side, usdg: proceeds, tokens: a.tokens, reason: a.voided ? 'series voided' : a.won ? `${a.side} won` : `${a.side} lost`, tx });
      return;
    }
    if (a.type === 'SELL') {
      const t = a.tranche;
      let proceeds, tx = null;
      if (live) {
        const tokens = Math.min(t.tokens, view.held?.[t.seriesId]?.[t.side] ?? t.tokens);
        const sg = await getSigner(s);
        const q = await quoteSellRaw(rpc, t.side, tokens);
        const r = await sg.sell(t.side, tokens, q);
        proceeds = r.proceeds; tx = r.tx;
      } else proceeds = a.fill?.proceeds;
      if (!(proceeds >= 0)) throw new Error('no fill');
      closeTranches(st, [t], proceeds, now, a.reason, 'CLOSED');
      fill(st, { act: 'SELL', seriesId: t.seriesId, side: t.side, usdg: proceeds, tokens: t.tokens, price: proceeds / t.tokens, reason: a.reason, tx, pnl: proceeds - t.costUsdg });
      return;
    }
    if (a.type === 'BUY') {
      const checks = checksOf(s);
      let tokens, tx = null;
      if (live) {
        const sg = await getSigner(s);
        // the desk's price right now, before signing: the plan's edge must still be there
        const q = await quoteBuyRaw(rpc, a.side, a.spend);
        const avg = a.spend / (Number(q) / 1e18);
        const edge = (a.modelP - avg) * 100;
        if (edge < a.minEdgeCents - checks.maxQuoteSlipCents) throw new Error(`the desk's price moved: ${(avg * 100).toFixed(1)}¢ leaves ${edge.toFixed(1)}¢ of edge`);
        if (view.allowance == null || view.allowance < BigInt(Math.round(a.spend * 1e6))) {
          await sg.approve(Math.max(a.spend, limits.maxSpendPerSeries));   // the desk may draw at most one series budget
          view.allowance = BigInt(Math.round(Math.max(a.spend, limits.maxSpendPerSeries) * 1e6));
        }
        const s0 = view.bySeries[a.seriesId];
        const r = await sg.buy(a.side, a.spend, q, a.side === 'HIGHER' ? s0.higherToken : s0.lowerToken);
        tokens = r.tokens; tx = r.tx;
        view.allowance -= BigInt(Math.round(a.spend * 1e6));
      } else tokens = a.fill?.tokens;
      if (!(tokens > 0)) throw new Error('no fill');
      const t = { id: 't' + (st.nextId++), seriesId: a.seriesId, side: a.side, tokens, costUsdg: a.spend, spendUsdg: a.spend, avgPrice: a.spend / tokens,
        openedAt: now, status: 'OPEN', tx, kind: a.kind, modelP: a.modelP };
      st.tranches.push(t);
      seriesBook(st, a.seriesId).spent += a.spend;
      fill(st, { act: 'BUY', seriesId: a.seriesId, side: a.side, usdg: a.spend, tokens, price: a.spend / tokens, reason: a.reason, tx, modelP: a.modelP });
    }
  }
  function fill(st, f) {
    const ev = { kind: 'fill', paper: st.mode !== 'live', ...f };
    activity(ev);
    relay?.report(ev);
    log(`${ev.paper ? '[paper] ' : ''}${f.act} #${f.seriesId} ${f.side} ${money(f.usdg)} — ${f.reason}`);
  }

  function statusLine(st) {
    const open = openTranches(st);
    const cur = lastView?.cur;
    return {
      v: VERSION, mode: st.mode, series: cur?.seriesId ?? null, phase: cur?.phase ?? null,
      open: open.length, side: open.find((t) => t.seriesId === cur?.seriesId)?.side ?? null,
      spent: cur ? st.series?.[cur.seriesId]?.spent ?? 0 : null, budget: limitsOf(settings()).maxSpendPerSeries,
      pnl: lastPlan?.pnl?.total ?? null, usdg: lastView?.usdg ?? null, lossStop: !!st.lossStop?.tripped,
      decision: String(lastPlan?.decision || '').slice(0, 160), error: lastError ? lastError.slice(0, 160) : null
    };
  }

  return {
    tick,
    status() {
      const st = ledger(), s = settings();
      return { ...statusLine(st), ledger: st, view: lastView && { ...lastView, allowance: undefined }, plan: lastPlan && { decision: lastPlan.decision, blocks: lastPlan.blocks, verify: lastPlan.verify, pnl: lastPlan.pnl, limits: lastPlan.limits },
        relay: { paired: !!s.relayToken && (relay ? relay.paired : true), error: relay?.lastError ?? null, control: relay?.control ?? null }, activity: store.log().slice(-50).reverse() };
    },
    setLocalStop(on, { flatten = false, reset = false } = {}) {
      const st = ledger();
      st.stop = { ...st.stop, local: !!on, flattenLocal: !!flatten };
      if (reset) clearLossStops(st);
      store.saveLedger(st);
      notice(on ? 'stopped-local' : 'resumed-local', on ? (flatten ? 'Selling everything and stopping (from the setup page).' : 'Stopped from the setup page.') : 'Resumed from the setup page.', 0);
    },
    signer: (s) => getSigner(s || settings()),
    relay: () => relayFor(settings()),
    notice
  };
}

function clearLossStops(st) {
  st.lossStop = { tripped: false, reason: null, at: null };
  st.realizedSinceReset = 0;
  for (const b of Object.values(st.series || {})) b.lossStop = false;
}
function closeTranches(st, tranches, proceeds, now, reason, status) {
  const total = tranches.reduce((a, t) => a + t.tokens, 0) || 1;
  for (const t of tranches) {
    const got = proceeds * (t.tokens / total);
    t.status = status; t.closedAt = now; t.proceeds = got; t.pnl = got - t.costUsdg; t.closeReason = reason;
    seriesBook(st, t.seriesId).realized += t.pnl;
    st.realizedSinceReset = (st.realizedSinceReset || 0) + t.pnl;
  }
}
