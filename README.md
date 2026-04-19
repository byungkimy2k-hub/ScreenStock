# IBD Screener Agent

Logs into [IBD Stock Screener](https://ibdstockscreener.investors.com), scrapes nine preset lists, ranks symbols that appear on **2 or more lists**, flags newly seen symbols vs the previous run, and emails a summary via **Gmail**.

> **Status:** scaffolded (step 1 of 5). Login, scraping, aggregation, and scheduling are implemented in subsequent steps.

## Requirements

- Node.js **20+** (tested on Node 22)
- npm 10+
- A Gmail account with **2-Step Verification** enabled and a [Google App Password](https://support.google.com/accounts/answer/185833)
- An IBD Stock Screener account

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# then edit .env with your credentials
```

### `.env` variables

| Variable | Description |
| --- | --- |
| `IBD_USER` / `IBD_PASSWORD` | IBD Stock Screener login |
| `GMAIL_USER` | Gmail address used to send summaries |
| `GMAIL_APP_PASSWORD` | 16-char Google App Password (NOT your account password) |
| `EMAIL_TO` | Recipient address |
| `EMAIL_FROM` | Optional display From (defaults to `GMAIL_USER`) |
| `SKIP_EARLY_CLOSE_DAYS` | If `true`, skip NYSE early-close days. Default `false` (13:30 PT = 16:30 ET, after the 13:00 ET close) |
| `DATA_DIR` | Path for persisted state. Default `./data` |

## Commands

```bash
npm run login      # one-off: opens a headed browser, you sign in, session is saved
npm run scan       # one-off: scrape lists, aggregate, email summary
npm run schedule   # long-running: node-cron at 13:30 America/Los_Angeles, Mon-Fri
npm run build      # compile TS to dist/
npm run typecheck  # type-check without emitting
```

## Scheduling

Default trigger: **`30 13 * * 1-5` America/Los_Angeles**, with NYSE market-holiday skip (data file at `data/market-holidays.json`).

You can use either:

- `npm run schedule` (in-process, node-cron daemon), or
- **Windows Task Scheduler** invoking `npm run scan` at the same cadence (more reliable on Windows).

## Project layout

```
src/
  config.ts       # zod-validated env loader
  index.ts        # CLI entry (login | scan | schedule)
data/             # gitignored: storage-state.json, last-state.json, market-holidays.json
```

## Notice

Automated access may be subject to IBD's terms of service. You are responsible for compliance.
"# ScreenStock" 
