# Security

## Who holds what

| | You (your computer) | NetNet Intel | Telegram |
|---|---|---|---|
| Bot wallet key and recovery words | ✓ (`/data/wallet.json`, or your environment) | never | never |
| Page password | ✓ (scrypt hash) | never | never |
| Limits, withdraw address | ✓ | never | never |
| Pairing code | ✓ | a SHA-256 fingerprint only | the message showing it once |
| Fills, alerts, status line | ✓ | relayed to your chat; the latest status line is kept | your chat |

## What each party can do

- **NetNet Intel's signal** (the model and checks) can make the bot see an edge. It can't make the bot trade past your limits, and the bot ignores it unless it agrees with the chain: same series and line, a recent number, Treasury.rfv() within 0.5%. Every buy is re-quoted on chain before signing, with a 1.5% floor.
- **NetNet Intel's relay** can stop the bot, resume it (within your limits; this resets the loss stops), or tell it to sell what it holds. It can't make it buy, change a limit, or move funds. Withdrawals go only to the address saved on your page.
- **Telegram (@netnetintel_bot)** is how you send those commands. Anyone who controls your Telegram account can do the same.
- **The setup page** can do everything, so it answers only on this computer (Docker publishes it to 127.0.0.1), refuses requests from other web sites (Host and Origin checks), and needs your password. Withdrawing and showing the recovery words ask for the password again.
- **The desk approval** is capped at one series budget, not unlimited.

## Recommendations

- Use the bot's own wallet and fund it with only what it may risk. Keep the rest in your main wallet.
- Write the 12 words on paper. Don't screenshot them or put them in a chat, an email, or an AI assistant.
- Don't publish port 8787 beyond 127.0.0.1, and don't put the page on the internet.
- Update with `docker pull` (see README). Images are built from this repository's source by its GitHub workflow.

Report a problem privately: open a GitHub security advisory on this repository.
