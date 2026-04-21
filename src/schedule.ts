import fs from 'node:fs/promises';
import { z } from 'zod';

/**
 * NYSE market-calendar helpers. The scheduler itself has been moved out of
 * the Node process (Windows Task Scheduler -> `npm run scan`), but we still
 * want to short-circuit runs on holidays when `scan` is triggered; this
 * module provides the holiday loader and date-matching primitives used by
 * `runOnce`.
 */

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
 * caller simply won't skip any days. All dates are expected in
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
          `Scans will run every weekday. Create one with ` +
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
 * default (matching the README) is to still run, since 12:30 PT = 15:30 ET
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
