# Advanced setup

## Docker Compose

```
docker compose up -d        # with docker-compose.yml from this folder
```

## Settings from the environment

Everything is set on the setup page. These environment variables override the page at start-up, for servers and scripted installs:

| Variable | Meaning |
|---|---|
| `MAX_SPEND_PER_SERIES` | USDG the bot may put into one series in total. No default: nothing trades without it |
| `MAX_TICKET` | largest single buy (default 20% of the budget) |
| `LOSS_STOP_SERIES` | stop buying on a series once it is down this much (default half the budget) |
| `LOSS_STOP_TOTAL` | stop buying everywhere once down this much since the last reset (default one budget) |
| `RESERVE_USDG` | USDG always left in the wallet |
| `MODE` | `paper` (default) or `live` |
| `WITHDRAW_TO` | your main wallet address; the only place withdrawals go |
| `RELAY_TOKEN` | the pairing code from /selfhost |
| `RPC_URL` | your own Robinhood Chain RPC (https). Default: the public RPC |
| `TICK_SECONDS` | how often the bot decides (minimum 60, default 120) |
| `REQUIRE_HEALTH=false` | trade without the site's pre-trade checks (not recommended) |
| `REQUIRE_RFV_MATCH=false` | skip the Treasury.rfv() cross-check (not recommended) |
| `BOT_PRIVATE_KEY` or `BOT_PRIVATE_KEY_FILE` | use an existing key instead of a wallet made on the page. It's read from the environment or a Docker secret file and never written to disk. Use a wallet that holds only what the bot may risk |
| `ALLOWED_HOSTS` | extra host names the setup page answers to, comma-separated. Keep the page off the internet: it controls a wallet |
| `PORT`, `DATA_DIR` | the page's port (8787) and the data folder (`/data`) |

Example with a Docker secret:

```
services:
  bot:
    image: ghcr.io/nodecattel/netnetintel-bot:latest
    environment:
      BOT_PRIVATE_KEY_FILE: /run/secrets/bot_key
      MAX_SPEND_PER_SERIES: "200"
    secrets: [bot_key]
secrets:
  bot_key:
    file: ./bot_key.txt
```

## Without Docker

```
npm ci --omit=dev
DATA_DIR=./data node src/main.mjs
```

Node 22 or newer. The page is then at http://localhost:8787. Keep `./data` private: it holds the wallet.

## Build the image yourself

```
docker build -t netnetintel-bot .
docker run -d --name netnetintel-bot --restart unless-stopped -p 127.0.0.1:8787:8787 -v netnetintel-bot-data:/data netnetintel-bot
```

## The data folder

| File | What |
|---|---|
| `wallet.json` | the bot wallet's key and recovery words (unless the key comes from the environment) |
| `settings.json` | limits, mode, withdraw address, pairing code |
| `ledger.json` | the bot's positions, spend and results per series, loss-stop state |
| `activity.json` | the last 200 events shown on the page |
| `auth.json` | the page password, as a scrypt hash |

Back up the recovery words, not the folder. Anyone who can read `wallet.json` can take the bot's funds.

## The strategy

`src/vendor/strategy.mjs` is generated from the site's own strategy code (`predictStrategy.ts`), the same rules as the paper bot on netnetintel.com and its backtest. The knobs (edge thresholds, take-profit, adds) are the site's defaults. `settings.json` → `strategy` overrides them by name, for those who know what they are changing.
