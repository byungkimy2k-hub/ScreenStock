import { loadConfig, loadPaths, type AppConfig } from './config.js';
import { loginAutomated, loginInteractive, openAuthenticatedContext } from './auth.js';
import { scrapeAllLists, type ScrapeResult } from './scrape.js';
import { aggregateAndDiff, type AggregationResult } from './aggregate.js';
import { buildEmailContent, sendSummary } from './email.js';
import { loadMarketHolidays, shouldSkipToday, todayInEasternTime } from './schedule.js';

type Command = 'scan' | 'login' | 'help';

function parseCommand(argv: string[]): Command {
  const cmd = argv[2]?.toLowerCase();
  if (cmd === 'scan' || cmd === 'login') return cmd;
  return 'help';
}

function printHelp(): void {
  process.stdout.write(
    [
      'IBD Screener Agent',
      '',
      'Usage:',
      '  npm run login              Headed automated login using IBD_USER / IBD_PASSWORD from .env',
      '  npm run login -- --manual  Headed interactive login (you sign in by hand)',
      '  npm run scan               Scrape all 9 IBD preset lists, aggregate, diff vs last run, email summary',
      '  npm run scan -- --no-email Same as scan, but skip sending the Gmail summary (useful for testing)',
      '  npm run scan -- --force    Same as scan, but ignore the NYSE holiday skip',
      '  npm run scan -- --debug    Same as scan, plus dump per-list page HTML / screenshot / API payload to data/',
      '',
      'Scheduling is handled by the OS (Windows Task Scheduler). See scripts/task-scheduler/ for importable XMLs.',
      '',
    ].join('\n'),
  );
}

async function runLogin(argv: string[]): Promise<void> {
  const manual = argv.includes('--manual');
  if (manual) {
    const paths = loadPaths();
    await loginInteractive(paths);
    return;
  }
  const config = loadConfig();
  await loginAutomated(config.paths, config.ibd, { headless: false });
}

function printScrapeResult(result: ScrapeResult, minCompRating: number, maxResults: number): void {
  process.stdout.write(`\n=== ${result.list} (${result.listId}) ===\n`);
  process.stdout.write(`URL    : ${result.url}\n`);
  process.stdout.write(
    `Filter : Composite Rating >= ${minCompRating}, capped at ${maxResults || '\u221e'}\n`,
  );
  if (result.totalReturned > 0) {
    process.stdout.write(
      `Stocks : ${result.symbols.length} (from ${result.totalReturned} total ${result.list} entries)\n`,
    );
  } else {
    process.stdout.write(`Count  : ${result.symbols.length}\n`);
  }
  if (result.rows.length > 0) {
    process.stdout.write('\nRows (sorted by Composite Rating, highest first):\n');
    process.stdout.write(
      `  ${'Sym'.padEnd(6)} ${'Company'.padEnd(30)} Comp  EPS   RS  Price\n`,
    );
    for (const r of result.rows) {
      process.stdout.write(
        `  ${r.symbol.padEnd(6)} ${(r.company ?? '').slice(0, 30).padEnd(30)} ` +
          `${String(r.compRating ?? '-').padStart(3)}  ` +
          `${String(r.epsRating ?? '-').padStart(3)}  ` +
          `${String(r.rsRating ?? '-').padStart(3)}  ` +
          `${(r.price ?? 0).toFixed(2).padStart(8)}\n`,
      );
    }
  }
  if (result.symbols.length > 0) {
    process.stdout.write(
      `\nSymbols (${result.symbols.length}): ${result.symbols.join(', ')}\n`,
    );
  } else {
    process.stdout.write('No symbols matched this list under the current filter.\n');
  }
}

type RunOnceOptions = {
  debug?: boolean;
  sendEmail?: boolean;
  /** Skip the NYSE holiday / early-close check (for manual re-runs on days off). */
  force?: boolean;
};

/**
 * One end-to-end scan -> aggregate -> (optional) email cycle. Also the
 * single code path invoked by Windows Task Scheduler via `npm run scan`,
 * so the holiday guard lives here rather than in a scheduling daemon.
 */
async function runOnce(config: AppConfig, options: RunOnceOptions = {}): Promise<void> {
  const debug = options.debug ?? false;
  const sendEmail = options.sendEmail ?? true;
  const force = options.force ?? false;

  if (!force) {
    const holidays = await loadMarketHolidays(config.paths.holidaysFile);
    const today = todayInEasternTime();
    const skip = shouldSkipToday(today, holidays, {
      skipEarlyCloseDays: config.schedule.skipEarlyCloseDays,
    });
    if (skip) {
      process.stdout.write(
        `[${today}] skipping scan: NYSE ${skip} day. Re-run with --force to override.\n`,
      );
      return;
    }
  }

  const { context } = await openAuthenticatedContext(config.paths, { headless: false });
  try {
    const results = await scrapeAllLists(context, {
      debugDir: debug ? config.paths.dataDir : undefined,
      minCompRating: config.screener.minCompRating,
      maxResults: config.screener.maxResults,
    });

    for (const result of results) {
      printScrapeResult(result, config.screener.minCompRating, config.screener.maxResults);
    }

    // Brief per-list summary at the end so the output is skimmable.
    process.stdout.write('\n=== Summary ===\n');
    process.stdout.write(
      `Filter : Composite Rating >= ${config.screener.minCompRating}, capped at ${
        config.screener.maxResults || '\u221e'
      } per list\n`,
    );
    const totalSymbols = new Set<string>();
    for (const r of results) {
      for (const s of r.symbols) totalSymbols.add(s);
      process.stdout.write(
        `  ${r.list.padEnd(28)} ${String(r.symbols.length).padStart(4)} symbols` +
          (r.totalReturned > 0 ? ` (of ${r.totalReturned})` : '') +
          '\n',
      );
    }
    process.stdout.write(
      `\nUnique symbols across all ${results.length} lists: ${totalSymbols.size}\n`,
    );
    if (results.length === 0) {
      process.stdout.write(
        'No lists were scraped. Re-run `npm run login` if your session expired.\n',
      );
      return;
    }

    const aggregation = await aggregateAndDiff(results, config.paths.lastStateFile, {
      minListCount: config.screener.minListCount,
    });
    printAggregation(aggregation, config.paths.lastStateFile);

    if (sendEmail) {
      await sendEmailStep(results, aggregation, config);
    } else {
      process.stdout.write('\nEmail : skipped (--no-email)\n');
    }
  } finally {
    await context.close();
  }
}

async function runScan(argv: string[]): Promise<void> {
  const debug = argv.includes('--debug');
  const sendEmail = !argv.includes('--no-email');
  const force = argv.includes('--force');
  const config = loadConfig();
  await runOnce(config, { debug, sendEmail, force });
}

async function sendEmailStep(
  results: ScrapeResult[],
  aggregation: AggregationResult,
  config: AppConfig,
): Promise<void> {
  const content = buildEmailContent(results, aggregation, {
    minCompRating: config.screener.minCompRating,
    maxResults: config.screener.maxResults,
    minListCount: config.screener.minListCount,
  });
  process.stdout.write(`\n=== Email ===\n`);
  process.stdout.write(`To      : ${config.email.to}\n`);
  process.stdout.write(`From    : ${config.email.from}\n`);
  process.stdout.write(`Subject : ${content.subject}\n`);
  try {
    const info = await sendSummary(config.email, content);
    process.stdout.write(`Sent    : accepted=${info.accepted.join(',') || '(none)'}`);
    if (info.rejected.length > 0) {
      process.stdout.write(`  rejected=${info.rejected.join(',')}`);
    }
    process.stdout.write(`\nId      : ${info.messageId}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`email failed: ${message}\n`);
  }
}

function printAggregation(agg: AggregationResult, stateFile: string): void {
  process.stdout.write('\n=== Aggregation (symbols on 2+ lists) ===\n');
  process.stdout.write(
    `Threshold : appears on >= ${agg.minListCount} preset list${agg.minListCount === 1 ? '' : 's'}\n`,
  );
  process.stdout.write(`Matches   : ${agg.appearances.length}\n`);

  if (agg.appearances.length > 0) {
    process.stdout.write(
      `\n  ${'Sym'.padEnd(6)} ${'Company'.padEnd(28)} N  Comp EPS  RS  Price    Lists\n`,
    );
    for (const a of agg.appearances) {
      process.stdout.write(
        `  ${a.symbol.padEnd(6)} ${(a.company ?? '').slice(0, 28).padEnd(28)} ` +
          `${String(a.listCount).padStart(1)}  ` +
          `${String(a.compRating ?? '-').padStart(3)}  ` +
          `${String(a.epsRating ?? '-').padStart(3)}  ` +
          `${String(a.rsRating ?? '-').padStart(3)}  ` +
          `${(a.price ?? 0).toFixed(2).padStart(7)}  ` +
          `${a.lists.join(', ')}\n`,
      );
    }
  }

  process.stdout.write('\n--- Diff vs previous run ---\n');
  if (!agg.hasPreviousRun) {
    process.stdout.write(
      `No previous state found (${stateFile}). This run establishes the baseline.\n`,
    );
  } else {
    process.stdout.write(
      `Newcomers (${agg.newcomers.length})` +
        (agg.newcomers.length > 0 ? `: ${agg.newcomers.join(', ')}` : '') +
        '\n',
    );
    process.stdout.write(
      `Departures (${agg.departures.length})` +
        (agg.departures.length > 0 ? `: ${agg.departures.join(', ')}` : '') +
        '\n',
    );
  }
  process.stdout.write(`\nState saved to ${stateFile}\n`);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);

  switch (command) {
    case 'help':
      printHelp();
      return;
    case 'login':
      await runLogin(process.argv.slice(3));
      return;
    case 'scan':
      await runScan(process.argv.slice(3));
      return;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
