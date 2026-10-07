// Files in the data folder (a Docker volume): settings, the bot's ledger, its wallet and the page password. Written
// atomically (temp file + rename) and readable only by the bot's user. Nothing here ever leaves the machine except
// what relay.mjs reports.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function makeStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (name) => join(dir, name);
  const read = (name, dflt = null) => {
    try { return existsSync(p(name)) ? JSON.parse(readFileSync(p(name), 'utf8')) : dflt; } catch (e) { throw new Error(`${name} is unreadable: ${e.message}`); }
  };
  const write = (name, value) => {
    const tmp = p(name + '.tmp');
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, p(name));
    try { chmodSync(p(name), 0o600); } catch { /* filesystems without modes */ }
  };
  return {
    dir,
    settings: () => read('settings.json', {}),
    saveSettings: (s) => write('settings.json', s),
    ledger: () => read('ledger.json', null),
    saveLedger: (l) => write('ledger.json', l),
    wallet: () => read('wallet.json', null),
    saveWallet: (wl) => write('wallet.json', wl),
    auth: () => read('auth.json', null),
    saveAuth: (a) => write('auth.json', a),
    log: () => read('activity.json', []),
    saveLog: (l) => write('activity.json', l.slice(-200))
  };
}
