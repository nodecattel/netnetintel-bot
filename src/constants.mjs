// Fixed addresses and defaults. Everything here is public on chain.
export const CHAIN_ID = 4663;                                              // Robinhood Chain
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER_TX = 'https://robin.etherscan.io/tx/';
export const EXPLORER_ADDR = 'https://robin.etherscan.io/address/';
export const DESK = '0x7EF9528408D99f98056922291048F0710001e015';          // NetNet Predict desk
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';          // USDG, 6 decimals
export const TREASURY = '0x04822Ea321A0DEE6F40656172F29312104855d66';      // Treasury.rfv() is part of the graded number
export const SIGNAL_URL = 'https://netnetintel.com/functions/getPredictState';
export const RELAY_URL = 'https://netnetintel.com/functions/selfHostRelay';

export const SEL = {
  seriesCount: '0xd7f2c0ef', halted: '0xb9b8af0b', minTicket: '0xf6a30e3e', series: '0xdc22cb6a',
  quoteBuy: '0xc7d4bc7f', quoteSell: '0x6d6c8295', buy: '0x01a9812c', sell: '0xde254659', redeem: '0xe43f80a5',
  rfv: '0x4dc8d6df', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3', transfer: '0xa9059cbb'
};
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// The owner's limits. maxSpendPerSeries has no default: the bot will not trade until it is set.
export const DEFAULT_LIMITS = {
  maxSpendPerSeries: null,   // USDG the bot may put into one series in total (buys, not net of sells)
  maxTicket: null,           // largest single buy; empty = 20% of the series budget (the first ticket's size)
  lossStopSeries: null,      // stop buying on a series once it is down this much (realized + open marks); empty = half the budget
  lossStopTotal: null,       // stop buying everywhere once down this much since the last reset; empty = the series budget
  reserveUsdg: 0             // USDG always left in the wallet
};
export const DEFAULT_CHECKS = {
  requireHealth: true,       // the site's pre-trade checks must all pass (Safe transfers, jumps, parity, memo, freshness, code)
  requireRfvMatch: true,     // the signal's Treasury.rfv() must match the chain within rfvTolerancePct
  rfvTolerancePct: 0.5,
  maxSignalAgeMin: 15,       // the signal's number must be this recent
  maxQuoteSlipCents: 2       // re-quote right before signing: give up if the price moved this much against the plan
};
export const TICK_SECONDS = 120;   // how often the bot decides
export const LOOP_SECONDS = 15;    // how often it wakes (relay polls are paced by the relay)
export const GAS_FLOOR_ETH = 0.00006;   // three transactions' worth on Robinhood Chain
