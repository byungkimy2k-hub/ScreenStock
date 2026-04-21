import fs from 'node:fs/promises';
import cron, { type ScheduledTask } from 'node-cron';
import { z } from 'zod';

/** 13:30 Mon-Fri. At 13:30 PT = 16:30 ET, the regular NYSE session (09:30-16:00 ET) has closed. */
export const DEFAULT_CRON_EXPRESSION = '30 13 * * 1-5';
/**
 * 05:00 Mon-Fri. At 05:00 PT = 08:00 ET, pre-market has been running since
 * 04:00 ET and the regular open (09:30 ET / 06:30 PT) is ~90 min out. Gives
 * us a morning baseline ahead of the cash session.
 */
export const DEFAULT_PREMARKET_CRON_EXPRESSION = '0 5 * * 1-5';
export const DEFAULT_CRON_TIMEZONE = 'America/Los_Angeles';

/**
 * Accept either the structured shape (`{ holidays, earlyClose }`) or a
 * bare array of date strings (treated as full holidays). This lets users
 * drop in a minimal `["2026-01-01", ...]` file without extra ceremony.
 */
const MarketHolidaysSchema = z.union([
  z.array(z.string()),
  z.object({
    holidays: z.array(z.string()).default([]),
    earlyClose: z.array(z.string()).default([]),
  }),
]);

export type MarketHolidays = {
  holidays: Set<string>;
  earlyClose: Set<string>;
};

/**
 * Load NYSE holidays from disk. A missing file is NOT an error -- the
 * scheduler simply won't skip any days. All dates are expected in
 * `YYYY-MM-DD` form (Eastern-Time calendar, since that's how NYSE
 * publishes its holiday calendar).
 */
export async function loadMarketHolidays(holidaysFile: string): Promise<MarketHolidays> {
  let raw: string;
  try {
    raw = await fs.readFile(holidaysFile, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      process.stderr.write(
        `note: no market-holidays file at ${holidaysFile}. ` +
          `Scheduler will run every weekday. Create one with ` +
          `{"holidays":["YYYY-MM-DD", ...]} to skip NYSE holidays.\n`,
      );
    } else {
      process.stderr.write(
        `warning: could not read ${holidaysFile}: ${(err as Error).message}. Treating as empty.\n`,
      );
    }
    return { holidays: new Set(), earlyClose: new Set() };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `warning: ${holidaysFile} is not valid JSON: ${(err as Error).message}. Treating as empty.\n`,
    );
    return { holidays: new Set(), earlyClose: new Set() };
  }

  const parsed = MarketHolidaysSchema.safeParse(json);
  if (!parsed.success) {
    process.stderr.write(
      `warning: ${holidaysFile} has unexpected shape. Expected ["YYYY-MM-DD", ...] or ` +
        `{"holidays":[...], "earlyClose":[...]}. Treating as empty.\n`,
    );
    return { holidays: new Set(), earlyClose: new Set() };
  }

  if (Array.isArray(parsed.data)) {
    return { holidays: new Set(parsed.data), earlyClose: new Set() };
  }
  return {
    holidays: new Set(parsed.data.holidays),
    earlyClose: new Set(parsed.data.earlyClose),
  };
}

/**
 * Return today's date in `YYYY-MM-DD` form using the America/New_York
 * calendar. NYSE holidays are defined in ET, so date comparisons must also
 * be done in ET -- otherwise `America/Los_Angeles` rolls over three hours
 * "late", which is fine for Pacific-time scheduling but wrong for matching
 * a "Thanksgiving" entry.
 */
export function todayInEasternTime(now: Date = new Date()): string {
  // 'en-CA' renders the Gregorian date as YYYY-MM-DD; zero-padded parts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export type SkipReason = 'holiday' | 'early-close';

/**
 * Returns null if today is a regular trading day, or the reason to skip.
 * Early-close days are only skipped when `skipEarlyCloseDays` is true; the
 * default (matching the README) is to still run, since 13:30 PT = 16:30 ET
 * is well after the 13:00 ET early close.
 */
export function shouldSkipToday(
  today: string,
  holidays: MarketHolidays,
  opts: { skipEarlyCloseDays: boolean },
): SkipReason | null {
  if (holidays.holidays.has(today)) return 'holiday';
  if (opts.skipEarlyCloseDays && holidays.earlyClose.has(today)) return 'early-close';
  return null;
}

export type ScheduleOptions = {
  holidays: MarketHolidays;
  skipEarlyCloseDays: boolean;
  expression?: string;
  timezone?: string;
  /** Short label included in every log line for this task (e.g. "pre-market"). */
  name?: string;
  /** Override for tests / alternate sinks. Defaults to stdout with timestamps. */
  log?: (msg: string) => void;
};

/**
 * Schedule `handler` against one cron expression, skipping NYSE holidays
 * (and early-close days when configured). Handler errors are caught and
 * logged so one bad run doesn't tear down the long-running process.
 *
 * The returned `ScheduledTask` can be stopped individually; callers that
 * start multiple schedules are responsible for stopping each one.
 */
export function startSchedule(
  handler: () => Promise<void>,
  options: ScheduleOptions,
): ScheduledTask {
  const expression = options.expression ?? DEFAULT_CRON_EXPRESSION;
  const timezone = options.timezone ?? DEFAULT_CRON_TIMEZONE;
  const log = options.log ?? ((m) => process.stdout.write(`${m}\n`));
  const label = options.name ? `[${options.name}] ` : '';

  return cron.schedule(
    expression,
    async () => {
      const today = todayInEasternTime();
      const skip = shouldSkipToday(today, options.holidays, {
        skipEarlyCloseDays: options.skipEarlyCloseDays,
      });
      if (skip) {
        log(`${label}[${today}] skipping scheduled run: NYSE ${skip} day.`);
        return;
      }
      log(`${label}[${today}] scheduled run starting...`);
      const started = Date.now();
      try {
        await handler();
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        log(`${label}[${today}] scheduled run finished in ${secs}s.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${label}[${today}] scheduled run failed: ${message}\n`);
      }
    },
    { timezone },
  );
}
