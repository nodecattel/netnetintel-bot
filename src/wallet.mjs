// The bot's own wallet. By default setup makes a fresh one here, on the owner's machine: the owner funds it with only
// what the bot may risk, and nobody pastes a key anywhere. Advanced: BOT_PRIVATE_KEY (or a Docker secret file named by
// BOT_PRIVATE_KEY_FILE) uses an existing key instead; it is read from the environment and never written to disk.
import { readFileSync } from 'node:fs';

let envWallet;
export function walletOf(store) {
  if (envWallet === undefined) envWallet = fromEnv();
  if (envWallet) return envWallet;
  return store.wallet();
}
function fromEnv() {
  let pk = process.env.BOT_PRIVATE_KEY || '';
  if (!pk && process.env.BOT_PRIVATE_KEY_FILE) { try { pk = readFileSync(process.env.BOT_PRIVATE_KEY_FILE, 'utf8').trim(); } catch { pk = ''; } }
  if (!pk) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error('BOT_PRIVATE_KEY is not a 32-byte hex key');
  return { privateKey: pk.startsWith('0x') ? pk : '0x' + pk, address: null, fromEnv: true, backedUp: true };
}
export async function resolveEnvAddress() {
  if (envWallet && !envWallet.address) { const { Wallet } = await import('ethers'); envWallet.address = new Wallet(envWallet.privateKey).address; }
}

export async function createWallet(store) {
  if (walletOf(store)) throw new Error('the bot already has a wallet');
  const { Wallet } = await import('ethers');
  const wl = Wallet.createRandom();
  const rec = { address: wl.address, privateKey: wl.privateKey, phrase: wl.mnemonic?.phrase || null, createdAt: new Date().toISOString(), backedUp: false };
  store.saveWallet(rec);
  return rec;
}
