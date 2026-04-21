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
| `SKIP_EARLY_CLOSE_DAYS` | If `true`, skip NYSE early-close days. Default `false` (12:30 PT = 15:30 ET, after the 13:00 ET early close) |
| `MIN_COMP_RATING` | Per-list Composite Rating cutoff. Default `94` (IBD's own default). |
| `MAX_RESULTS` | Cap per list, applied after sorting by Composite Rating. Default `100`; `0` = no cap. |
| `MIN_LIST_COUNT` | Aggregation threshold. Symbols appearing on fewer than this many lists are dropped. Default `2`. |
| `DATA_DIR` | Path for persisted state. Default `./data` |

## Commands

```bash
npm run login                     # one-off: headed automated login, session is persisted in data/browser-profile
npm run login -- --manual         # headed interactive login (sign in by hand)
npm run scan                      # one-off: scrape 9 lists, aggregate, diff, email (skips NYSE holidays)
npm run scan -- --no-email        # same as scan, but skip the Gmail send (handy for testing)
npm run scan -- --force           # same as scan, but ignore the NYSE holiday skip (manual re-run on days off)
npm run scan -- --debug           # scan + dump per-list debug HTML / screenshot / raw JSON under data/
npm run build                     # compile TS to dist/
npm run typecheck                 # type-check without emitting
```

## Scheduling

Scheduling is delegated to the OS; there is no in-process daemon. Each trigger invokes `npm run scan` and the process exits after one end-to-end cycle.

Two daily triggers, local time, Mon-Fri:

| Name         | Local time | ET time   | Intent                                          |
| ------------ | ---------- | --------- | ----------------------------------------------- |
| `pre-market` | 05:00      | 08:00 ET  | Morning baseline ~90 min before the 06:30 PT open. |
| `after-close`| 12:30      | 15:30 ET  | Late-session snapshot, ~30 min before the 13:00 PT / 16:00 ET close. |

Both runs share the same `data/last-state.json`, so each run's "diff" is against whichever run came before it — the morning shows overnight scoring moves, the afternoon shows intraday moves.

### Windows Task Scheduler

Ready-to-import XMLs live in `scripts/task-scheduler/`. From PowerShell in the project root:

```powershell
schtasks /Create /TN "IBD Screener\Pre-Market Scan"  /XML "scripts\task-scheduler\IBD-Screener-Premarket.xml"  /F
schtasks /Create /TN "IBD Screener\After-Close Scan" /XML "scripts\task-scheduler\IBD-Screener-AfterClose.xml" /F
```

Both tasks are configured to wake the computer from Sleep and run on AC or battery. Output is appended to `data\scheduled.log`. See the notes in `scripts/task-scheduler/` for power-plan requirements and troubleshooting.

### NYSE holiday skip

`scan` reads `data/market-holidays.json` at the start of every run. If today matches, the scan logs and exits cleanly (so Task Scheduler doesn't mark it as failed). Override for a manual re-run with `npm run scan -- --force`.

The holidays file is optional — if missing, `scan` runs on every trigger and logs a one-time note.

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

## Project layout

```
src/
  config.ts       # zod-validated env loader
  auth.ts         # Playwright login + authenticated-context helper
  scrape.ts       # per-list scraper + PRESET_LISTS + scrapeAllLists
  aggregate.ts    # cross-list aggregation + diff vs previous run + state file
  email.ts        # Gmail/Nodemailer summary (pure formatter + sender)
  schedule.ts     # NYSE holiday loader + skip-today helper
  index.ts        # CLI entry (login | scan)
scripts/
  task-scheduler/ # Windows Task Scheduler XMLs for the two daily triggers
data/             # gitignored: storage-state.json, last-state.json, market-holidays.json, scheduled.log
```

## Notice

Automated access may be subject to IBD's terms of service. You are responsible for compliance.
"# ScreenStock" 
