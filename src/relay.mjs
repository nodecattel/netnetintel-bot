// The link to @netnetintel_bot. The bot sends netnetintel.com short reports (fills, loss stops, problems, a status
// line) and asks it for the owner's commands (stop, resume, sell all). It never sends the wallet's key or its recovery
// phrase, and the relay can never make it buy: its commands only stop, resume within the owner's local limits, or sell.
import { RELAY_URL } from './constants.mjs';

export const VERSION = '1.0.0';
const MAX_QUEUE = 30;

export function makeRelay({ token, url = RELAY_URL, fetchImpl = fetch, log = () => {} }) {
  const queue = [];
  let pollSec = 60, nextPoll = 0, lastControl = null, paired = !!token, lastError = null;
  async function post(body) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, v: VERSION, ...body }), signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => null);
    if (res.status === 401) { paired = false; throw new Error('the Telegram link was revoked or is wrong — make a new code with /selfhost'); }
    if (!res.ok || !j?.ok) throw new Error(j?.error || 'relay HTTP ' + res.status);
    return j;
  }
  return {
    get paired() { return paired; },
    get lastError() { return lastError; },
    get control() { return lastControl; },
    report(ev) { if (!token) return; queue.push({ ...ev, at: Date.now() }); while (queue.length > MAX_QUEUE) queue.shift(); },
    async flush() {
      if (!token || !queue.length) return;
      const batch = queue.splice(0, 10);
      try { await post({ action: 'report', events: batch }); lastError = null; } catch (e) { queue.unshift(...batch); lastError = e.message; log('relay report: ' + e.message); }
    },
    // the owner's commands; null when the relay can't be reached (the bot then keeps its last known stop state)
    async poll(status, now = Date.now(), force = false) {
      if (!token) return null;
      if (!force && now < nextPoll) return lastControl;
      nextPoll = now + pollSec * 1000;
      try {
        const j = await post({ action: 'poll', status });
        pollSec = Math.min(600, Math.max(20, Number(j.pollSec) || 60));
        nextPoll = now + pollSec * 1000;
        lastControl = { stop: !!j.stop, flattenSeq: Number(j.flattenSeq) || 0, resetSeq: Number(j.resetSeq) || 0, at: now };
        lastError = null;
      } catch (e) { lastError = e.message; log('relay poll: ' + e.message); }
      return lastControl;
    }
  };
}
