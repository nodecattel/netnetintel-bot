// NetNet Intel self-run Predict bot. Starts the setup page and the trading loop.
//   DATA_DIR   where settings, the ledger and the bot wallet live (Docker: the /data volume)
//   PORT       the setup page (Docker publishes it on 127.0.0.1 only)
// Everything else is set on the setup page; ADVANCED.md lists the environment overrides.
import { makeStore } from './store.mjs';
import { makeBot } from './trader.mjs';
import { startServer } from './server.mjs';
import { resolveEnvAddress } from './wallet.mjs';
import { TICK_SECONDS, LOOP_SECONDS } from './constants.mjs';
import { VERSION } from './relay.mjs';

const store = makeStore(process.env.DATA_DIR || './data');
await resolveEnvAddress();
applyEnv(store);
const bot = makeBot({ store, log: (m) => console.log(new Date().toISOString(), m) });
const port = Number(process.env.PORT) || 8787;
startServer({ store, bot, port, allowedHosts: String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) });
console.log(`NetNet Intel bot ${VERSION} — setup page: http://localhost:${port}`);

let lastTick = 0;
async function loop() {
  const now = Date.now();
  const s = store.settings() || {};
  const every = Math.max(60, Number(s.tickSeconds) || TICK_SECONDS) * 1000;
  try {
    // a relay command (stop / sell all) is picked up on the next wake, without waiting for the next decision
    const rc = await bot.relay().poll(null, now);
    const st = store.ledger();
    const urgent = rc && st && ((rc.flattenSeq > (st.seen?.flattenSeq || 0)) || (rc.resetSeq > (st.seen?.resetSeq || 0)) || (!!rc.stop !== !!st._wasStopped));
    if (urgent || now - lastTick >= every) { lastTick = now; await bot.tick({ now }); }
  } catch (e) { console.log('loop:', e.message); }
  setTimeout(loop, LOOP_SECONDS * 1000);
}
setTimeout(loop, 3000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log('stopping'); process.exit(0); });

// Advanced: settings from the environment override the page (documented in ADVANCED.md)
function applyEnv(store) {
  const e = process.env, s = store.settings() || {};
  const n = (k) => (e[k] != null && e[k] !== '' ? Number(e[k]) : undefined);
  const lim = { maxSpendPerSeries: n('MAX_SPEND_PER_SERIES'), maxTicket: n('MAX_TICKET'), lossStopSeries: n('LOSS_STOP_SERIES'), lossStopTotal: n('LOSS_STOP_TOTAL'), reserveUsdg: n('RESERVE_USDG') };
  if (Object.values(lim).some((v) => v !== undefined)) s.limits = { ...(s.limits || {}), ...Object.fromEntries(Object.entries(lim).filter(([, v]) => v !== undefined)) };
  if (e.MODE === 'live' || e.MODE === 'paper') s.mode = e.MODE;
  if (e.RELAY_TOKEN) s.relayToken = e.RELAY_TOKEN;
  if (e.WITHDRAW_TO) s.withdrawTo = e.WITHDRAW_TO;
  if (e.RPC_URL) s.rpcUrl = e.RPC_URL;
  if (e.TICK_SECONDS) s.tickSeconds = Number(e.TICK_SECONDS);
  if (e.REQUIRE_HEALTH === 'false' || e.REQUIRE_RFV_MATCH === 'false') s.checks = { ...(s.checks || {}), ...(e.REQUIRE_HEALTH === 'false' ? { requireHealth: false } : {}), ...(e.REQUIRE_RFV_MATCH === 'false' ? { requireRfvMatch: false } : {}) };
  store.saveSettings(s);
}
