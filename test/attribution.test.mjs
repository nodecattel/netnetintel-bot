// ERC-8021 attribution on the bot's desk transactions: the exact bytes (checked on chain against the desk on
// 7 Oct 2026: a tagged buy reads the same inputs and takes the same path as an untagged one), the round trip, and that
// the bot signs with the tag unless the owner turned it off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributionSuffix, readAttribution, tagged } from '../src/chain.mjs';
import { ATTRIBUTION_CODE } from '../src/constants.mjs';
import { makeStore } from '../src/store.mjs';
import { makeBot } from '../src/trader.mjs';

test('the suffix is ERC-8021 schema 0: codes, length, schema id, marker', () => {
  assert.equal(attributionSuffix('netnetintel'), '6e65746e6574696e74656c0b0080218021802180218021802180218021');
  assert.equal(attributionSuffix(ATTRIBUTION_CODE), '6e65746e6574696e74656c5f626f740f0080218021802180218021802180218021');
  assert.equal(attributionSuffix(['a', 'b']), '612c62030080218021802180218021802180218021');
  assert.equal(attributionSuffix(''), '');
  assert.throws(() => attributionSuffix('bad code'));
});

test('read back from the end of calldata; untagged calldata reads null', () => {
  const buy = '0x01a9812c' + '1'.padStart(64, '0') + '5f5e100'.padStart(64, '0') + '0'.padStart(64, '0');
  assert.deepEqual(readAttribution(tagged(buy, attributionSuffix(ATTRIBUTION_CODE))), [ATTRIBUTION_CODE]);
  assert.deepEqual(readAttribution(tagged(buy, attributionSuffix(['netnetintel_bot', 'x']))), ['netnetintel_bot', 'x']);
  assert.equal(readAttribution(buy), null);
  assert.equal(tagged(buy, ''), buy);
});

test('the bot signs with the tag by default and without it when the owner turns it off', async () => {
  const store = makeStore(mkdtempSync(join(tmpdir(), 'nnib-')));
  store.saveWallet({ address: '0x' + 'c'.repeat(40), privateKey: '0x' + '1'.repeat(64), backedUp: true });
  const seen = [];
  const bot = makeBot({ store, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }), log: () => {},
    signerFactory: async (pk, rpc, opts) => { seen.push(opts.tag); return { address: '0x' + 'c'.repeat(40), tag: opts.tag }; } });
  store.saveSettings({ mode: 'live' });
  assert.equal((await bot.signer()).tag, attributionSuffix(ATTRIBUTION_CODE));
  store.saveSettings({ mode: 'live', attribution: false });
  assert.equal((await bot.signer()).tag, '');
  assert.deepEqual(seen, [attributionSuffix(ATTRIBUTION_CODE), '']);
});
