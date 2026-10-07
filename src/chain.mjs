// Chain reads (plain JSON-RPC) and the four transactions the bot can send: approve the desk for USDG, buy, sell and
// redeem on the desk — plus withdrawing to the owner's own address from the local page. Every buy and sell is
// re-quoted by the desk right before signing and sent with a floor 1.5% under that quote, so a moved book reverts
// instead of filling worse.
import { decodeSeries, deriveSeries, minOut } from './vendor/strategy.mjs';
import { CHAIN_ID, DESK, USDG, TREASURY, SEL, TRANSFER_TOPIC, ERC8021_MARKER } from './constants.mjs';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word0 = (hex) => (hex && hex !== '0x' && hex.length >= 66 ? BigInt('0x' + hex.slice(2, 66)) : null);

export function makeRpc(url, fetchImpl = fetch) {
  let id = 0;
  return async function rpc(calls) {
    const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params }));
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('RPC HTTP ' + res.status);
    const arr = await res.json();
    const byId = new Map((Array.isArray(arr) ? arr : [arr]).map((r) => [r.id, r]));
    return body.map((b) => byId.get(b.id) || { error: { message: 'missing' } });
  };
}
const call = (to, data) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });

// Everything one tick needs: the desk, the live series (decoded and derived exactly as the site does), any series the
// bot still holds, the wallet's balances, and the desk's sell quote for every open tranche on the live series.
export async function readView(rpc, me, tranches = [], now = Date.now()) {
  const head = await rpc([call(DESK, SEL.seriesCount), call(DESK, SEL.halted), call(DESK, SEL.minTicket), call(TREASURY, SEL.rfv), { method: 'eth_blockNumber', params: [] }]);
  const ok = (r) => r?.result && r.result !== '0x';
  if (!ok(head[0])) throw new Error('the desk did not answer');
  const count = parseInt(head[0].result, 16);
  const halted = ok(head[1]) && BigInt(head[1].result) !== 0n;
  const minTicket = ok(head[2]) ? Number(BigInt(head[2].result)) / 1e6 : null;
  const rfv = ok(head[3]) ? Number(BigInt(head[3].result)) / 1e18 : null;
  const block = ok(head[4]) ? parseInt(head[4].result, 16) : null;
  const ids = [...new Set([count, ...tranches.map((t) => t.seriesId)])].filter((i) => i > 0);
  const sr = await rpc(ids.map((i) => call(DESK, SEL.series + w(i))));
  const bySeries = {};
  ids.forEach((i, k) => { const d = decodeSeries(sr[k]?.result); if (d && d.line > 0) bySeries[i] = { ...d, seriesId: i, halted }; });
  const raw = bySeries[count];
  const cur = raw ? { ...deriveSeries(raw, now), seriesId: count } : null;
  const view = { block, count, halted, minTicket, rfv, bySeries, cur, me, usdg: null, eth: null, held: {}, marks: {}, allowance: null };
  if (!me) return view;

  const reads = [call(USDG, SEL.balanceOf + addrWord(me)), { method: 'eth_getBalance', params: [me, 'latest'] }, call(USDG, SEL.allowance + addrWord(me) + addrWord(DESK))];
  const tok = [];
  for (const i of ids) { const s = bySeries[i]; if (!s) continue; tok.push([i, 'HIGHER', s.higherToken], [i, 'LOWER', s.lowerToken]); }
  for (const [, , t] of tok) reads.push(call(t, SEL.balanceOf + addrWord(me)));
  const r = await rpc(reads);
  view.usdg = ok(r[0]) ? Number(BigInt(r[0].result)) / 1e6 : null;
  view.eth = ok(r[1]) ? Number(BigInt(r[1].result)) / 1e18 : null;
  view.allowance = ok(r[2]) ? BigInt(r[2].result) : 0n;
  tok.forEach(([i, side], k) => { const x = r[3 + k]; (view.held[i] ||= {})[side] = ok(x) ? Number(BigInt(x.result)) / 1e18 : null; });

  const live = tranches.filter((t) => t.status === 'OPEN' && cur && t.seriesId === cur.seriesId && cur.sellsOpen);
  if (live.length) {
    const q = await rpc(live.map((t) => call(DESK, SEL.quoteSell + w(t.side === 'HIGHER' ? 1 : 0) + w(toRaw18(t.tokens)))));
    live.forEach((t, k) => { const v = word0(q[k]?.result); if (v != null) view.marks[t.id] = Number(v) / 1e6; });
  }
  return view;
}
const toRaw18 = (x) => BigInt(Math.floor(x * 1e6)) * 10n ** 12n;   // tokens rounded down to 1e-6, never more than held
export const toRaw6 = (x) => BigInt(Math.round(x * 1e6));

export async function quoteBuyRaw(rpc, side, usdg) {
  const r = await rpc([call(DESK, SEL.quoteBuy + w(side === 'HIGHER' ? 1 : 0) + w(toRaw6(usdg)))]);
  const v = word0(r[0]?.result); if (!v) throw new Error('the desk gave no buy quote'); return v;
}
export async function quoteSellRaw(rpc, side, tokens) {
  const r = await rpc([call(DESK, SEL.quoteSell + w(side === 'HIGHER' ? 1 : 0) + w(toRaw18(tokens)))]);
  const v = word0(r[0]?.result); if (!v) throw new Error('the desk gave no sell quote'); return v;
}

// ERC-8021 schema-0 suffix: the codes (ASCII, comma-separated), their length (1 byte), the schema id 0x00, the marker.
export function attributionSuffix(codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean).join(',');
  if (!list) return '';
  if (!/^[\x21-\x7e]+$/.test(list) || list.length > 255) throw new Error('attribution codes must be printable ASCII, at most 255 bytes');
  const hex = [...list].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return hex + list.length.toString(16).padStart(2, '0') + '00' + ERC8021_MARKER;
}
// the attribution codes at the end of calldata, or null
export function readAttribution(data) {
  const d = String(data || '').replace(/^0x/, '').toLowerCase();
  if (!d.endsWith(ERC8021_MARKER) || d.length < 2 * 18) return null;
  const end = d.length - ERC8021_MARKER.length;
  if (d.slice(end - 2, end) !== '00') return null;                 // schema 0 only
  const len = parseInt(d.slice(end - 4, end - 2), 16);
  const start = end - 4 - len * 2;
  if (start < 8) return null;
  return d.slice(start, end - 4).match(/../g).map((b) => String.fromCharCode(parseInt(b, 16))).join('').split(',');
}
export const tagged = (data, suffix) => (suffix ? data + suffix : data);

// The signer. ethers is loaded only here, only in live mode. tag: the attribution suffix for desk calls ('' for none).
export async function makeSigner(privateKey, rpcUrl, { tag = '' } = {}) {
  const { Wallet, JsonRpcProvider } = await import('ethers');
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  const wallet = new Wallet(privateKey, provider);
  const me = wallet.address.toLowerCase();
  async function send(to, data, value = 0n) {
    const tx = await wallet.sendTransaction({ to, data, value });   // estimateGas first: a call that would revert is never sent
    const rc = await tx.wait(1, 180000);
    if (!rc || rc.status !== 1) throw new Error('transaction reverted: ' + tx.hash);
    return rc;
  }
  const transfersTo = (rc, token) => (rc.logs || []).filter((l) => (!token || l.address?.toLowerCase() === token.toLowerCase()) &&
    l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics?.[2]?.slice(-40).toLowerCase() === me.slice(2));
  return {
    address: wallet.address, tag,
    async approve(amountUsdg) { return send(USDG, SEL.approve + addrWord(DESK) + w(toRaw6(amountUsdg))); },
    async buy(side, usdg, quoteRaw, token) {
      const rc = await send(DESK, tagged(SEL.buy + w(side === 'HIGHER' ? 1 : 0) + w(toRaw6(usdg)) + w(minOut(quoteRaw)), tag));
      const t = transfersTo(rc, token)[0];
      if (!t) throw new Error('no outcome tokens arrived in ' + rc.hash);
      return { tokens: Number(BigInt(t.data)) / 1e18, tx: rc.hash };
    },
    async sell(side, tokens, quoteRaw) {
      const rc = await send(DESK, tagged(SEL.sell + w(side === 'HIGHER' ? 1 : 0) + w(toRaw18(tokens)) + w(minOut(quoteRaw)), tag));
      const t = transfersTo(rc, USDG)[0];
      if (!t) throw new Error('no USDG arrived in ' + rc.hash);
      return { proceeds: Number(BigInt(t.data)) / 1e6, tx: rc.hash };
    },
    async redeem(seriesId, side, tokens) {
      const rc = await send(DESK, tagged(SEL.redeem + w(seriesId) + w(side === 'HIGHER' ? 1 : 0) + w(toRaw18(tokens)), tag));
      const t = transfersTo(rc, USDG)[0];
      return { proceeds: t ? Number(BigInt(t.data)) / 1e6 : 0, tx: rc.hash };
    },
    async withdrawUsdg(to, raw) { return (await send(USDG, SEL.transfer + addrWord(to) + w(raw))).hash; },
    async withdrawEth(to, keepWei = 0n) {
      const bal = await provider.getBalance(wallet.address);
      const fee = await provider.getFeeData();
      const gas = 21000n * ((fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n);
      const value = bal - gas - keepWei;
      if (value <= 0n) throw new Error('nothing to send after gas');
      const tx = await wallet.sendTransaction({ to, value, gasLimit: 21000n });
      await tx.wait(1, 180000);
      return tx.hash;
    }
  };
}
