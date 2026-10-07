# NetNet Intel bot — run your own Predict bot

[bot.netnetintel.com](https://bot.netnetintel.com) · A bot for NetNet's weekly Treasury prediction market on Robinhood Chain that runs **on your own computer**. It trades the [netnetintel.com](https://netnetintel.com/predict) model from **its own wallet**, made on your machine, never past the limits you set, and reports to you on Telegram.

**Your key stays with you.** NetNet Intel never sees the bot's key or its recovery words, and has no way to move its funds. Fan-made, not affiliated with NetNet Capital. Not financial advice: a Predict token pays $1 or $0, so the bot can lose everything you give it. Start on paper.

## Set it up

You need **Docker Desktop** ([download](https://www.docker.com/products/docker-desktop/)), installed and running. Then pick one:

**With your AI assistant (easiest).** Paste this into Claude, ChatGPT or another assistant:

> Set up the NetNet Intel bot on my computer. Follow https://netnetintel.com/skills/netnet-bot/SKILL.md step by step, and run the commands for me if you can.

**One line.** Open Terminal (Mac) or PowerShell (Windows), paste, press Enter:

```
docker run -d --name netnetintel-bot --restart unless-stopped -p 127.0.0.1:8787:8787 -v netnetintel-bot-data:/data ghcr.io/nodecattel/netnetintel-bot:latest
```

**Double-click.** Download the [starter](https://bot.netnetintel.com/downloads/netnetintel-bot-starter.zip), unzip it and open the file for your computer. On a Mac, right-click it and choose Open the first time.

Then open **http://localhost:8787**. The page walks you through it:

1. Choose a password for the page.
2. Make the bot's wallet and write down its 12 recovery words.
3. Set your budget per series, largest buy and loss stops, and your main wallet (withdrawals go only there).
4. Link Telegram: send `/selfhost` to [@netnetintel_bot](https://t.me/netnetintel_bot), tap *Make a pairing code*, paste it.
5. Watch it on paper. When you're ready, send the bot's wallet USDG (your budget) and a little ETH for gas on Robinhood Chain, and type LIVE.

The bot only runs while your computer is on and awake.

## What it does every two minutes

1. **Reads the chain:** the live series, the desk's prices, its own balances, and Treasury.rfv().
2. **Reads the signal** from netnetintel.com: the model's odds and the site's pre-trade checks (Safe transfers, jumps in the number, parity at the open, formula changes, freshness). It uses the signal **only if it agrees with the chain**: same series, same line, a recent number, and the same Treasury.rfv() within 0.5%.
3. **Decides** with the same strategy code the site's paper bot and backtest run ([`src/vendor/strategy.mjs`](src/vendor/strategy.mjs)): a first ticket on a real edge, a few spaced adds, take-profit, an exit when the edge is gone. It stands aside when the model and the market are too far apart to trust.
4. **Applies your limits last.** They can only shrink or stop a trade: the series budget, the largest buy, the loss stops, the USDG reserve and a gas floor.
5. **Re-quotes before signing.** Right before each buy or sell it asks the desk for a fresh price, gives up if the edge has gone, and sends the order with a floor 1.5% under that quote, so a moved market cancels the order instead of filling it worse.

## You stay in control

- **Stop:** `/stop` in Telegram or *Stop* on the page. The bot sends no transactions until you resume, and keeps what it holds.
- **Sell all and stop:** a button in Telegram and on the page.
- **Resume:** `/resume` or *Resume*. This also resets the loss stops.
- **Withdraw** all USDG and ETH to your saved main wallet from the page, with your password.

Telegram can stop it, resume it, or make it sell. It can't make the bot buy, raise its limits, or send funds anywhere. Those are set only on your page.

## What goes through NetNet Intel

The bot sends short reports to netnetintel.com, which forwards them to your Telegram chat: fills (side, amount, price, transaction link), alerts, and a status line (mode, series, spend, result). It also checks there about once a minute for your Stop, Resume and Sell-all commands. It never sends the key, the recovery words or your page password. To run without Telegram, skip the pairing step.

## More

- [ADVANCED.md](ADVANCED.md): Compose, environment settings, your own RPC, using an existing key, building from source.
- [SECURITY.md](SECURITY.md): what is stored where and what each party can and cannot do.
- `npm test` runs the tests (Node 22).
- The setup page uses the netnetintel.com typefaces, Instrument Serif and Inter (SIL Open Font License), bundled in the image so the page loads nothing from the internet.
