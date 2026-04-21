# IBD Screener Agent

Logs into [IBD Stock Screener](https://ibdstockscreener.investors.com), scrapes nine preset lists, ranks symbols that appear on **2 or more lists**, flags newly seen symbols vs the previous run, and emails a summary via **Gmail**.

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
| `MIN_COMP_RATING` | Per-list Composite Rating cutoff. Default `94` (IBD's own default). |
| `MAX_RESULTS` | Cap per list, applied after sorting by Composite Rating. Default `100`; `0` = no cap. |
| `MIN_LIST_COUNT` | Aggregation threshold. Symbols appearing on fewer than this many lists are dropped. Default `2`. |
| `DATA_DIR` | Path for persisted state. Default `./data` |

## Commands

```bash
npm run login                     # one-off: headed automated login, session is persisted in data/browser-profile
npm run login -- --manual         # headed interactive login (sign in by hand)
npm run scan                      # one-off: scrape 9 lists, aggregate, diff, email
npm run scan -- --no-email        # same as scan, but skip the Gmail send (handy for testing)
npm run scan -- --debug           # scan + dump per-list debug HTML / screenshot / raw JSON under data/
npm run schedule                  # long-running: node-cron at 13:30 America/Los_Angeles, Mon-Fri
npm run schedule -- --run-now     # schedule + trigger an immediate scan on startup
npm run schedule -- --no-email    # schedule, but scheduled runs do not send email
npm run build                     # compile TS to dist/
npm run typecheck                 # type-check without emitting
```

## Scheduling

Two daily triggers on America/Los_Angeles, Mon-Fri:

| Name         | Cron             | PT time   | ET time   | Intent                                          |
| ------------ | ---------------- | --------- | --------- | ----------------------------------------------- |
| `pre-market` | `0 5 * * 1-5`    | 05:00 PT  | 08:00 ET  | Morning baseline ~90 min before the 06:30 PT open. |
| `after-close`| `30 13 * * 1-5`  | 13:30 PT  | 16:30 ET  | Post-close snapshot after the 13:00 PT / 16:00 ET close. |

Both runs share the same `data/last-state.json`, so each run's "diff" is against whichever run came before it — the morning shows overnight scoring moves, the afternoon shows intraday moves.

NYSE market-holiday skip is driven by `data/market-holidays.json`. The holidays file is optional — if missing, the scheduler runs every weekday and logs a one-time note.

Supported holidays-file shapes:

```jsonc
// Simple: bare list of full-close holidays (YYYY-MM-DD, Eastern-Time calendar).
["2026-01-01", "2026-01-19", "2026-02-16"]

// Structured: separate early-close list (only skipped when SKIP_EARLY_CLOSE_DAYS=true).
{
  "holidays":   ["2026-01-01", "2026-11-26", "2026-12-25"],
  "earlyClose": ["2026-07-02", "2026-11-27", "2026-12-24"]
}
```

Two ways to run it:

- `npm run schedule` (in-process, node-cron daemon). Stop with Ctrl+C.
- **Windows Task Scheduler** invoking `npm run scan` at the same cadence (more reliable on Windows, since the cron daemon is only alive while the terminal is open).

## Project layout

```
src/
  config.ts       # zod-validated env loader
  auth.ts         # Playwright login + authenticated-context helper
  scrape.ts       # per-list scraper + PRESET_LISTS + scrapeAllLists
  aggregate.ts    # cross-list aggregation + diff vs previous run + state file
  email.ts        # Gmail/Nodemailer summary (pure formatter + sender)
  schedule.ts     # holidays loader + node-cron wiring
  index.ts        # CLI entry (login | scan | schedule)
data/             # gitignored: storage-state.json, last-state.json, market-holidays.json
```

## Notice

Automated access may be subject to IBD's terms of service. You are responsible for compliance.
"# ScreenStock" 
