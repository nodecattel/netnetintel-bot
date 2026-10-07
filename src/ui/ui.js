// The setup page: a password, the bot's own wallet, the limits, Telegram, then paper or live. No libraries, nothing
// loaded from the internet; it only talks to the bot on this computer.
const $app = document.getElementById('app'), $pills = document.getElementById('pills');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (v) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (v) => (v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${usd(v)}</span>`);
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
let S = null, view = null, phrase = null, flash = '';
const head = (title, sub = '') => `<div class="section"><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>`;

// light / dark, as on netnetintel.com (dark by default)
const $theme = document.getElementById('theme');
const setTheme = (t) => { document.documentElement.classList.toggle('light', t === 'light'); $theme.textContent = t === 'light' ? 'Dark' : 'Light'; try { localStorage.setItem('netnet-theme', t); } catch (e) {} };
setTheme((() => { try { return localStorage.getItem('netnet-theme') === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; } })());
$theme.onclick = () => setTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'failed (' + r.status + ')');
  return j;
}
async function load() { S = await api('/api/state'); render(); }
function err(id, e) { const el = document.getElementById(id); if (el) el.textContent = e.message || e; }

function render() {
  $pills.innerHTML = '';
  if (S.auth === 'setup') return passwordScreen(true);
  if (S.auth === 'login') return passwordScreen(false);
  const st = S.status, s = S.settings;
  const stopped = !!st?.ledger?.stop?.local || !!st?.relay?.control?.stop;
  $pills.innerHTML = `<span class="pill ${s.mode === 'live' ? 'live' : 'paper'}">${s.mode === 'live' ? 'Live' : 'Paper'}</span><span class="pill ${stopped ? 'stop' : 'run'}">${stopped ? 'Stopped' : 'Running'}</span>`;
  if (view === 'settings') return settingsScreen();
  if (!S.wallet || !S.wallet.backedUp) return walletStep();
  if (s.effective.maxSpendPerSeries == null) return limitsStep(true);
  if (!s.paired && !localStorage.getItem('nnib-skip-tg')) return telegramStep(true);
  return dashboard();
}

function steps(n) {
  const names = ['Wallet', 'Budget & limits', 'Telegram', 'Paper, then live'];
  return `<div class="steps">${names.map((x, i) => `<span class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}">${i + 1}. ${x}</span>`).join('')}</div>`;
}

function passwordScreen(first) {
  $app.innerHTML = `<div class="card" style="max-width:460px;margin:30px auto">
    <h1>${first ? 'Welcome' : 'Log in'}</h1>
    <p class="muted">${first ? 'Choose a password for this page. It protects your bot on this computer — anyone who opens the page needs it.' : 'Enter the password you chose for this page.'}</p>
    <label for="pw">Password</label><input id="pw" type="password" autocomplete="${first ? 'new-password' : 'current-password'}" minlength="8">
    ${first ? '<label for="pw2">Again</label><input id="pw2" type="password" autocomplete="new-password">' : ''}
    <div class="row"><button class="primary" id="go">${first ? 'Set password' : 'Log in'}</button></div><div class="err" id="e"></div></div>`;
  const go = async () => {
    const pw = document.getElementById('pw').value;
    if (first && pw !== document.getElementById('pw2').value) return err('e', 'The two passwords differ');
    try { await api(first ? '/api/password' : '/api/login', { password: pw }); await load(); } catch (e) { err('e', e); }
  };
  document.getElementById('go').onclick = go;
  document.getElementById('pw').onkeydown = (e) => { if (e.key === 'Enter' && !first) go(); };
}

function walletStep() {
  const w = S.wallet;
  if (phrase) {
    const words = phrase.split(' ');
    $app.innerHTML = `${head(`Write down these ${words.length} words`, 'The only backup of the bot\'s wallet')}${steps(1)}<div class="card">
      <p>They are the only backup of the bot's wallet. Anyone with them can take its funds; without them, a lost computer means lost funds.</p>
      <div class="note warn">Write them on paper, in order. Don't screenshot them, email them, or paste them into a chat — @netnetintel_bot and NetNet Intel will never ask for them.</div>
      <div class="phrase">${words.map((x, i) => `<div><b>${i + 1}</b>${esc(x)}</div>`).join('')}</div>
      <label><input type="checkbox" id="ok"> I wrote the words down and put them somewhere safe</label>
      <div class="row"><button class="primary" id="go" disabled>Continue</button></div></div>`;
    document.getElementById('ok').onchange = (e) => { document.getElementById('go').disabled = !e.target.checked; };
    document.getElementById('go').onclick = async () => { await api('/api/wallet/backed-up', {}); phrase = null; await load(); };
    return;
  }
  if (w && !w.backedUp) {
    $app.innerHTML = `${head('Back up the bot\'s wallet')}${steps(1)}<div class="card"><p>Enter your page password to see the recovery words again.</p>
      <label for="pw">Password</label><input id="pw" type="password"><div class="row"><button class="primary" id="go">Show the words</button></div><div class="err" id="e"></div></div>`;
    document.getElementById('go').onclick = async () => { try { const r = await api('/api/wallet/reveal', { password: document.getElementById('pw').value }); phrase = r.phrase; render(); } catch (e) { err('e', e); } };
    return;
  }
  $app.innerHTML = `${head('Make the bot\'s wallet', 'Step 1 of 4 · a new wallet, made on this computer')}${steps(1)}<div class="card">
    <p>The bot trades from <b>its own new wallet</b>, made here on your computer. You send it only what it may use — your series budget in USDG and a little ETH for gas — and keep the rest of your money in your main wallet.</p>
    <ul class="muted small"><li>The key never leaves this computer. NetNet Intel never sees it.</li><li>You can send everything back to your main wallet from this page at any time.</li></ul>
    <div class="row"><button class="primary" id="go">Make the wallet</button></div><div class="err" id="e"></div></div>`;
  document.getElementById('go').onclick = async () => { try { const r = await api('/api/wallet/create', {}); phrase = r.phrase; await load(); } catch (e) { err('e', e); } };
}

function limitsForm() {
  const l = S.settings.limits || {}, eff = S.settings.effective || {};
  const b = Number(l.maxSpendPerSeries) || 0;
  const f = (id, label, hint, v, ph) => `<label for="${id}">${label} <span class="muted">${hint}</span></label><input id="${id}" type="number" min="0" step="1" value="${v ?? ''}" placeholder="${ph}">`;
  return `${f('maxSpendPerSeries', 'Budget per series (USDG)', '— the most the bot puts into one weekly series, in total', l.maxSpendPerSeries, 'e.g. 200')}
    ${f('maxTicket', 'Largest single buy', '— empty: 20% of the budget', l.maxTicket, b ? (b * 0.2).toFixed(0) : '')}
    ${f('lossStopSeries', 'Stop buying on a series once it is down', '— empty: half the budget', l.lossStopSeries, b ? (b / 2).toFixed(0) : '')}
    ${f('lossStopTotal', 'Stop buying everywhere once down (since the last reset)', '— empty: one budget', l.lossStopTotal, b ? b.toFixed(0) : '')}
    ${f('reserveUsdg', 'Always leave in the wallet', '', l.reserveUsdg || '', '0')}
    <label for="withdrawTo">Your main wallet <span class="muted">— withdrawals go here and nowhere else</span></label><input id="withdrawTo" type="text" value="${esc(S.settings.withdrawTo || '')}" placeholder="0x…">
    ${eff.maxSpendPerSeries ? `<p class="muted small">Now: up to ${usd(eff.maxSpendPerSeries)} per series, ${usd(eff.maxTicket)} per buy, stops at −${usd(eff.lossStopSeries)} on a series and −${usd(eff.lossStopTotal)} overall.</p>` : ''}`;
}
async function saveLimits() {
  const v = (id) => document.getElementById(id).value;
  await api('/api/settings', { limits: { maxSpendPerSeries: v('maxSpendPerSeries'), maxTicket: v('maxTicket'), lossStopSeries: v('lossStopSeries'), lossStopTotal: v('lossStopTotal'), reserveUsdg: v('reserveUsdg') }, withdrawTo: v('withdrawTo').trim() });
}
function limitsStep() {
  $app.innerHTML = `${head('Budget and limits', 'Step 2 of 4 · the most the bot may ever do')}${steps(2)}<div class="card">
    <p class="muted">The bot follows the netnetintel.com model, but never past these limits. It stops buying when a loss stop is hit, and keeps what it holds until you decide.</p>
    ${limitsForm()}<div class="row"><button class="primary" id="go">Save</button></div><div class="err" id="e"></div></div>`;
  document.getElementById('go').onclick = async () => { try { await saveLimits(); await load(); } catch (e) { err('e', e); } };
}

function pairForm() {
  return `<ol><li>Open <b>@netnetintel_bot</b> in Telegram.</li><li>Send <code>/selfhost</code> and tap <b>Make a pairing code</b>.</li><li>Paste the code here.</li></ol>
    <p class="muted small">The bot then sends its trades and alerts to your chat, and you can stop it from Telegram with /stop. Only short reports go through NetNet Intel — never the wallet's key or words.</p>
    <label for="code">Pairing code</label><input id="code" type="text" placeholder="nnib_…" autocomplete="off" spellcheck="false">`;
}
function telegramStep() {
  $app.innerHTML = `${head('Link Telegram', 'Step 3 of 4 · trades and alerts in your chat, /stop from anywhere')}${steps(3)}<div class="card">${pairForm()}
    <div class="row"><button class="primary" id="go">Link</button><button id="skip">Skip for now</button></div><div class="err" id="e"></div></div>`;
  document.getElementById('go').onclick = async () => { try { await api('/api/pair', { code: document.getElementById('code').value }); await load(); } catch (e) { err('e', e); } };
  document.getElementById('skip').onclick = () => { localStorage.setItem('nnib-skip-tg', '1'); render(); };
}

function settingsScreen() {
  const s = S.settings;
  $app.innerHTML = `<div class="row" style="margin-top:0"><button id="back">« Back</button></div>${head('Settings', 'Limits, Telegram, safety checks and the wallet')}
    <div class="card"><h2>Budget and limits</h2>${limitsForm()}<div class="row"><button class="primary" id="saveL">Save</button></div><div class="err" id="eL"></div></div>
    <div class="card"><h2>Telegram</h2>${s.paired ? `<p>Linked. <button id="unpair">Unlink</button></p><p class="muted small">To link another chat, make a new code with /selfhost and paste it below.</p>` : ''}${pairForm()}
      <div class="row"><button class="primary" id="pair">Link</button></div><div class="err" id="eT"></div></div>
    <div class="card"><h2>Safety checks</h2>
      <label><input type="checkbox" id="ch1" ${s.checks.requireHealth !== false ? 'checked' : ''}> Wait for the site's pre-trade checks (formula, jumps, Safe transfers, parity)</label>
      <label><input type="checkbox" id="ch2" ${s.checks.requireRfvMatch !== false ? 'checked' : ''}> Compare the site's Treasury number with the chain before trading</label>
      <p class="muted small">Recommended on. Turning them off lets the bot trade through the kind of data error that made the site's paper bot lose on 6 Oct.</p>
      <div class="row"><button id="saveC">Save checks</button></div><div class="err" id="eC"></div></div>
    <div class="card"><h2>Wallet</h2><p class="mono">${esc(S.wallet?.address || '')}</p>
      ${S.wallet?.fromEnv ? '<p class="muted small">Key supplied by the environment (advanced setup).</p>' : `<label for="pwR">Password</label><input id="pwR" type="password"><div class="row"><button id="reveal">Show recovery words</button></div><div id="rv"></div><div class="err" id="eR"></div>`}</div>`;
  document.getElementById('back').onclick = () => { view = null; render(); };
  document.getElementById('saveL').onclick = async () => { try { await saveLimits(); await load(); flash = 'Saved.'; } catch (e) { err('eL', e); } };
  document.getElementById('pair').onclick = async () => { try { await api('/api/pair', { code: document.getElementById('code').value }); await load(); } catch (e) { err('eT', e); } };
  const un = document.getElementById('unpair'); if (un) un.onclick = async () => { await api('/api/unpair', {}); await load(); };
  document.getElementById('saveC').onclick = async () => { try { await api('/api/settings', { checks: { requireHealth: document.getElementById('ch1').checked, requireRfvMatch: document.getElementById('ch2').checked } }); await load(); } catch (e) { err('eC', e); } };
  const rv = document.getElementById('reveal');
  if (rv) rv.onclick = async () => { try { const r = await api('/api/wallet/reveal', { password: document.getElementById('pwR').value }); document.getElementById('rv').innerHTML = r.phrase ? `<div class="phrase">${r.phrase.split(' ').map((x, i) => `<div><b>${i + 1}</b>${esc(x)}</div>`).join('')}</div>` : `<p class="mono">${esc(r.privateKey)}</p>`; } catch (e) { err('eR', e); } };
}

function dashboard() {
  const st = S.status, s = S.settings, v = st.view || {}, led = st.ledger || {}, pl = st.plan || {};
  const cur = v.cur, stopped = !!led.stop?.local || !!st.relay?.control?.stop;
  const open = (led.tranches || []).filter((t) => t.status === 'OPEN');
  const marks = v.marks || {};
  const sb = cur ? led.series?.[cur.seriesId] : null;
  const health = pl.verify;
  const checks = [
    ...(health ? (health.ok ? [['✓', 'The site\'s signal matches the chain']] : health.problems.map((p) => ['✗', p])) : []),
    ...(led.lossStop?.tripped ? [['✗', 'Loss stop: ' + (led.lossStop.reason || '') + ' — press Resume to reset']] : []),
    ...(pl.blocks || []).map((b) => ['•', b])
  ];
  const funded = v.usdg != null && v.usdg > 0 && v.eth != null && v.eth > 0;
  $app.innerHTML = `${head('Your bot', s.mode === 'live' ? 'Trading real USDG on the netnetintel.com model, within your limits' : 'Paper trading on the netnetintel.com model — real prices, no real money')}
  ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}
  ${s.mode !== 'live' ? `<div class="card">${steps(4)}<h2>Practising on paper</h2>
    <p>The bot is trading on paper: real prices, no real money. Watch it for a while — when you're happy, fund the wallet and go live.</p>
    ${funded ? '' : `<div class="note">Fund the bot: send <b>USDG</b> (your budget) and a little <b>ETH</b> for gas, on Robinhood Chain, to <span class="mono">${esc(S.wallet?.address)}</span></div>`}
    <label for="live">Type <b>LIVE</b> to trade real USDG within your limits</label><input id="live" type="text" autocomplete="off">
    <div class="row"><button class="primary" id="goLive">Go live</button></div><div class="err" id="eLive"></div></div>` : ''}
  ${st.error ? `<div class="note bad">Last check failed: ${esc(st.error)}</div>` : ''}
  ${!s.paired ? `<div class="note">Telegram isn't linked — you won't hear about trades. <button id="toSettings2">Link it</button></div>` : ''}
  <div class="grid">
    <div class="card"><h2>Series</h2>${cur ? `<div class="big">#${cur.seriesId}</div><div class="muted">${esc(cur.phase)} · line $${(cur.line / 1e6).toFixed(2)}M · HIGHER ${cur.priceHigher != null ? (cur.priceHigher * 100).toFixed(1) + '¢' : '—'}</div>` : '<p class="muted">No series yet.</p>'}
      <p class="small"><b>Now:</b> ${esc(pl.decision || st.decision || 'waiting for the first check')}</p>
      <p class="muted small">Last check ${led.lastTick ? ago(led.lastTick.at) : '—'}</p></div>
    <div class="card"><h2>Results</h2><div class="big">${signed(pl.pnl?.total)}</div><div class="muted small">since the last reset (${s.mode === 'live' ? 'real' : 'paper'})</div>
      <p class="small">This series: spent ${usd(sb?.spent || 0)} of ${usd(s.effective.maxSpendPerSeries)}${pl.pnl?.bySeries?.[cur?.seriesId] ? ` · ${signed(pl.pnl.bySeries[cur.seriesId].total)}` : ''}</p></div>
    <div class="card"><h2>Bot wallet</h2><div class="big">${usd(v.usdg)}</div><div class="muted small">USDG · ETH ${v.eth != null ? v.eth.toFixed(5) : '—'}</div>
      <p class="mono small">${esc(S.wallet?.address || '')}</p></div>
  </div>
  <div class="card"><h2>Checks</h2>${checks.length ? checks.map(([m, t]) => `<div class="check ${m === '✓' ? 'ok' : m === '✗' ? 'bad' : ''}"><b>${m}</b><span>${esc(t)}</span></div>`).join('') : '<p class="muted">Waiting for the first check.</p>'}</div>
  <div class="card"><h2>Positions</h2>${open.length ? `<table><tr><th>Series</th><th>Side</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Now</th><th>Bought</th></tr>
    ${open.map((t) => `<tr><td>#${t.seriesId}</td><td>${t.side}</td><td class="num">${t.tokens.toFixed(2)}</td><td class="num">${usd(t.costUsdg)}</td><td class="num">${marks[t.id] != null ? usd(marks[t.id]) : '—'}</td><td>${when(t.openedAt)}</td></tr>`).join('')}</table>` : '<p class="muted">None open.</p>'}</div>
  <div class="card"><h2>Controls</h2>
    <div class="row" style="margin-top:0">${stopped ? '<button class="primary" id="resume">Resume</button>' : '<button id="stop">Stop</button><button class="danger" id="flat">Sell all &amp; stop</button>'}
      <button id="tick">Check now</button>${s.mode === 'live' ? '<button id="toPaper">Back to paper</button>' : ''}<button id="toSettings">Settings</button><button id="logout">Log out</button></div>
    <p class="muted small">Stop: no more transactions until you resume (also /stop in Telegram). Resume also resets the loss stops.</p>
    <h2 style="margin-top:16px">Withdraw</h2>${s.withdrawTo ? `<p class="small">To your main wallet <span class="mono">${esc(s.withdrawTo)}</span></p>
      <label for="pwW">Password</label><input id="pwW" type="password"><div class="row"><button id="wU">Withdraw USDG</button><button id="wA">Withdraw everything</button></div>` : '<p class="muted small">Save your main wallet in Settings to withdraw.</p>'}
    <div class="err" id="eC"></div></div>
  <div class="card"><h2>Activity</h2>${(st.activity || []).length ? `<ul class="list">${st.activity.map((a) => `<li><time>${when(a.at)}</time>${a.kind === 'fill' ? `${a.paper ? '[paper] ' : ''}<b>${a.act}</b> #${a.seriesId} ${a.side} ${usd(a.usdg)}${a.pnl != null ? ' (' + signed(a.pnl) + ')' : ''} — ${esc(a.reason)}${a.tx ? ` · <a href="https://robin.etherscan.io/tx/${esc(a.tx)}" target="_blank" rel="noopener">tx</a>` : ''}` : esc(a.text)}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>`;
  flash = '';
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); await load(); } catch (e) { err(id === 'goLive' ? 'eLive' : 'eC', e); el.disabled = false; } }; };
  on('goLive', () => api('/api/mode', { mode: 'live', confirm: document.getElementById('live').value.trim() }));
  on('stop', () => api('/api/stop', {}));
  on('flat', () => { if (!confirm('Sell everything the bot holds now and stop?')) throw new Error('cancelled'); return api('/api/stop', { flatten: true }); });
  on('resume', () => api('/api/resume', {}));
  on('tick', async () => { const r = await api('/api/tick', {}); flash = r.decision || 'Checked.'; });
  on('logout', () => api('/api/logout', {}));
  on('wU', async () => { const r = await api('/api/withdraw', { what: 'usdg', password: document.getElementById('pwW').value }); flash = r.usdgTx ? 'USDG sent.' : 'No USDG to send.'; });
  on('wA', async () => { if (!confirm('Send all USDG and ETH to your main wallet? The bot cannot trade without them.')) throw new Error('cancelled'); await api('/api/stop', {}); await api('/api/withdraw', { what: 'all', password: document.getElementById('pwW').value }); flash = 'Sent. The bot is stopped.'; });
  for (const id of ['toSettings', 'toSettings2']) { const el = document.getElementById(id); if (el) el.onclick = () => { view = 'settings'; render(); }; }
  on('toPaper', () => api('/api/mode', { mode: 'paper' }));
}

load().catch((e) => { $app.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; });
setInterval(() => { if (S?.auth === 'ok' && !view && !phrase && !document.activeElement?.matches('input')) load().catch(() => {}); }, 20000);
