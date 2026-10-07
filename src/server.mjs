// The setup page, on the owner's own machine only (Docker publishes it to 127.0.0.1). A password the owner picks on
// first visit protects it; requests from other sites are refused (Host and Origin checks), so a web page open in the
// same browser cannot drive it. It creates the bot wallet, sets the limits, pairs Telegram, switches paper/live, and
// withdraws — only ever to the address saved here.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walletOf, createWallet } from './wallet.mjs';
import { limitsOf } from './engine.mjs';
import { USDG, SEL } from './constants.mjs';
import { makeRpc } from './chain.mjs';
import { PUBLIC_RPC } from './constants.mjs';

const scrypt = promisify(_scrypt);
const here = dirname(fileURLToPath(import.meta.url));
const FILES = { '/': ['ui/index.html', 'text/html'], '/favicon.svg': ['ui/favicon.svg', 'image/svg+xml'], '/ui.js': ['ui/ui.js', 'text/javascript'], '/ui.css': ['ui/ui.css', 'text/css'] };
// the site's own typefaces (SIL Open Font License), served from the image so the page needs nothing from the internet
const FS = '../node_modules/@fontsource/';
const FONTS = {
  '/fonts/serif.woff2': FS + 'instrument-serif/files/instrument-serif-latin-400-normal.woff2',
  '/fonts/serif-italic.woff2': FS + 'instrument-serif/files/instrument-serif-latin-400-italic.woff2',
  '/fonts/inter-400.woff2': FS + 'inter/files/inter-latin-400-normal.woff2',
  '/fonts/inter-500.woff2': FS + 'inter/files/inter-latin-500-normal.woff2',
  '/fonts/inter-600.woff2': FS + 'inter/files/inter-latin-600-normal.woff2'
};
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY'
};
const SESSION_MS = 12 * 3600e3;
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export function startServer({ store, bot, port = 8787, host = '0.0.0.0', allowedHosts = [] }) {
  const sessions = new Map();
  const fails = [];
  const okHost = (h) => {
    const name = String(h || '').replace(/:\d+$/, '').toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]'].includes(name) || allowedHosts.includes(name);
  };
  async function hash(pw, salt = randomBytes(16)) { return { salt: salt.toString('hex'), hash: (await scrypt(pw, salt, 64)).toString('hex') }; }
  async function checkPw(pw) {
    const a = store.auth(); if (!a || typeof pw !== 'string') return false;
    const h = await scrypt(pw, Buffer.from(a.salt, 'hex'), 64);
    return timingSafeEqual(h, Buffer.from(a.hash, 'hex'));
  }
  const session = (req) => {
    const m = /(?:^|;\s*)nnib=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    const s = m && sessions.get(m[1]);
    return s && s > Date.now() ? m[1] : null;
  };

  const routes = {
    'GET /api/state': async (req, _b, authed) => {
      const auth = !store.auth() ? 'setup' : authed ? 'ok' : 'login';
      if (auth !== 'ok') return { auth };
      const s = store.settings() || {};
      const wl = walletOf(store);
      return { auth, settings: { mode: s.mode || 'paper', limits: { ...s.limits }, effective: limitsOf(s), withdrawTo: s.withdrawTo || null, checks: s.checks || {}, paired: !!s.relayToken },
        wallet: wl ? { address: wl.address, backedUp: !!wl.backedUp, fromEnv: !!wl.fromEnv } : null, status: bot.status() };
    },
    'POST /api/password': async (_r, b) => {
      if (store.auth()) throw httpErr(409, 'a password is already set');
      if (typeof b.password !== 'string' || b.password.length < 8) throw httpErr(400, 'use at least 8 characters');
      store.saveAuth(await hash(b.password));
      return { ok: true, login: true };
    },
    'POST /api/login': async (_r, b) => {
      const now = Date.now();
      while (fails.length && now - fails[0] > 60e3) fails.shift();
      if (fails.length >= 5) throw httpErr(429, 'too many tries — wait a minute');
      if (!(await checkPw(b.password))) { fails.push(now); throw httpErr(401, 'wrong password'); }
      return { ok: true, login: true };
    },
    'POST /api/logout': async (req) => { const t = session(req); if (t) sessions.delete(t); return { ok: true, logout: true }; },
    'POST /api/wallet/create': async () => { const w = await createWallet(store); return { address: w.address, phrase: w.phrase }; },
    'POST /api/wallet/backed-up': async () => { const w = store.wallet(); if (!w) throw httpErr(400, 'no wallet'); w.backedUp = true; store.saveWallet(w); return { ok: true }; },
    'POST /api/wallet/reveal': async (_r, b) => {
      if (!(await checkPw(b.password))) throw httpErr(401, 'wrong password');
      const w = store.wallet(); if (!w) throw httpErr(400, 'no wallet made here');
      return { phrase: w.phrase, privateKey: w.phrase ? null : w.privateKey };
    },
    'POST /api/settings': async (_r, b) => {
      const s = store.settings() || {};
      const num = (v, max = 1e6) => { if (v === '' || v == null) return null; const n = Number(v); if (!(n >= 0 && n <= max)) throw httpErr(400, 'numbers must be between 0 and ' + max); return n; };
      if (b.limits) s.limits = { maxSpendPerSeries: num(b.limits.maxSpendPerSeries), maxTicket: num(b.limits.maxTicket), lossStopSeries: num(b.limits.lossStopSeries), lossStopTotal: num(b.limits.lossStopTotal), reserveUsdg: num(b.limits.reserveUsdg) ?? 0 };
      if ('withdrawTo' in b) {
        if (b.withdrawTo && !isAddr(b.withdrawTo)) throw httpErr(400, 'that is not a wallet address (0x + 40 characters)');
        const me = walletOf(store)?.address;
        if (b.withdrawTo && me && b.withdrawTo.toLowerCase() === me.toLowerCase()) throw httpErr(400, 'use your main wallet, not the bot\'s own address');
        s.withdrawTo = b.withdrawTo || null;
      }
      if (b.checks) s.checks = { requireHealth: b.checks.requireHealth !== false, requireRfvMatch: b.checks.requireRfvMatch !== false };
      if (b.rpcUrl !== undefined) { if (b.rpcUrl && !/^https:\/\//.test(b.rpcUrl)) throw httpErr(400, 'the RPC address must start with https://'); s.rpcUrl = b.rpcUrl || undefined; }
      store.saveSettings(s);
      return { ok: true };
    },
    'POST /api/pair': async (_r, b) => {
      const code = String(b.code || '').trim();
      if (!/^nnib_[A-Za-z0-9_-]{30,80}$/.test(code)) throw httpErr(400, 'that does not look like a pairing code from /selfhost');
      const s = store.settings() || {}; s.relayToken = code; store.saveSettings(s);
      const rl = bot.relay();
      const c = await rl.poll({ v: 'pairing' }, Date.now(), true);
      if (!c) { s.relayToken = undefined; store.saveSettings(s); throw httpErr(400, rl.lastError || 'the relay did not answer'); }
      rl.report({ kind: 'notice', code: 'paired', text: 'Your bot is linked. You will get its trades and alerts here.' });
      await rl.flush();
      return { ok: true };
    },
    'POST /api/unpair': async () => { const s = store.settings() || {}; delete s.relayToken; store.saveSettings(s); return { ok: true }; },
    'POST /api/mode': async (_r, b) => {
      const s = store.settings() || {};
      if (b.mode === 'live') {
        const w = walletOf(store);
        if (b.confirm !== 'LIVE') throw httpErr(400, 'type LIVE to confirm');
        if (!w) throw httpErr(400, 'create the bot wallet first');
        if (!w.backedUp) throw httpErr(400, 'confirm you saved the recovery phrase first');
        if (limitsOf(s).maxSpendPerSeries == null) throw httpErr(400, 'set a series budget first');
        s.mode = 'live';
      } else s.mode = 'paper';
      store.saveSettings(s);
      bot.tick().catch(() => {});
      return { ok: true };
    },
    'POST /api/stop': async (_r, b) => { bot.setLocalStop(true, { flatten: !!b.flatten }); bot.tick().catch(() => {}); return { ok: true }; },
    'POST /api/resume': async () => { bot.setLocalStop(false, { reset: true }); bot.tick().catch(() => {}); return { ok: true }; },
    'POST /api/tick': async () => bot.tick().then((p) => ({ ok: true, decision: p?.decision ?? p?.error ?? p?.skipped ?? null })),
    'POST /api/withdraw': async (_r, b) => {
      if (!(await checkPw(b.password))) throw httpErr(401, 'wrong password');
      const s = store.settings() || {};
      if (!isAddr(s.withdrawTo)) throw httpErr(400, 'save your main wallet address first');
      const sg = await bot.signer(s);
      const rpc = makeRpc(s.rpcUrl || PUBLIC_RPC);
      const out = {};
      if (b.what === 'usdg' || b.what === 'all') {
        const r = await rpc([{ method: 'eth_call', params: [{ to: USDG, data: SEL.balanceOf + sg.address.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] }]);
        const raw = BigInt(r[0]?.result || '0x0');
        if (raw > 0n) out.usdgTx = await sg.withdrawUsdg(s.withdrawTo, raw);
      }
      if (b.what === 'eth' || b.what === 'all') out.ethTx = await sg.withdrawEth(s.withdrawTo);
      bot.notice('withdraw', 'Withdrawn to your saved address from the setup page.', 0);
      return { ok: true, ...out };
    }
  };

  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json', extra = {}) => {
      res.writeHead(status, { ...HEADERS, 'content-type': type + '; charset=utf-8', ...extra });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (!okHost(req.headers.host)) return send(403, { error: 'open this page at http://localhost:' + port });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && FONTS[url.pathname]) {
        res.writeHead(200, { ...HEADERS, 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(readFileSync(join(here, FONTS[url.pathname])));
      }
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [f, type] = FILES[url.pathname];
        return send(200, readFileSync(join(here, f), 'utf8'), type);
      }
      const key = req.method + ' ' + url.pathname;
      const fn = routes[key];
      if (!fn) return send(404, { error: 'not found' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (!origin || !okHost(new URL(origin).host) || new URL(origin).host !== req.headers.host) return send(403, { error: 'requests from other sites are refused' });
      }
      const authed = !!session(req);
      const open = ['GET /api/state', 'POST /api/password', 'POST /api/login'];
      if (!open.includes(key) && !authed) return send(401, { error: 'log in first' });
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 16384) return send(413, { error: 'too large' }); }
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'bad JSON' }); }
      }
      const out = await fn(req, body, authed);
      const extra = {};
      if (out?.login) {
        const t = randomBytes(32).toString('hex'); sessions.set(t, Date.now() + SESSION_MS);
        extra['set-cookie'] = `nnib=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
      }
      if (out?.logout) extra['set-cookie'] = 'nnib=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
      return send(200, out, 'application/json', extra);
    } catch (e) {
      return send(e.status || 500, { error: e.status ? e.message : 'failed: ' + String(e.message || e).slice(0, 200) });
    }
  });
  server.listen(port, host);
  return server;
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
