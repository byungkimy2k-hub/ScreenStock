import { loadConfig, loadPaths } from './config.js';
import { loginAutomated, loginInteractive, openAuthenticatedContext } from './auth.js';
import { scrapeNewHighs } from './scrape.js';

type Command = 'scan' | 'login' | 'schedule' | 'help';

function parseCommand(argv: string[]): Command {
  const cmd = argv[2]?.toLowerCase();
  if (cmd === 'scan' || cmd === 'login' || cmd === 'schedule') return cmd;
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
      '  npm run scan               Scrape lists (currently: New Highs only) and print symbols',
      '  npm run scan -- --debug    Same as scan, plus dump page HTML / screenshot / selector counts to data/',
      '  npm run schedule           Start node-cron loop (weekdays 13:30 America/Los_Angeles) -- not yet implemented',
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

async function runScan(argv: string[]): Promise<void> {
  const debug = argv.includes('--debug');
  const config = loadConfig();
  const { context } = await openAuthenticatedContext(config.paths, { headless: false });
  try {
    const result = await scrapeNewHighs(context, {
      debugDir: debug ? config.paths.dataDir : undefined,
      minCompRating: config.screener.minCompRating,
      maxResults: config.screener.maxResults,
    });
    process.stdout.write(`\n=== ${result.list} ===\n`);
    process.stdout.write(`URL    : ${result.url}\n`);
    process.stdout.write(
      `Filter : Composite Rating >= ${config.screener.minCompRating}, capped at ${
        config.screener.maxResults || '\u221e'
      }\n`,
    );
    if (result.totalReturned > 0) {
      process.stdout.write(
        `Stocks : ${result.symbols.length} (from ${result.totalReturned} total New Highs entries)\n`,
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
      process.stdout.write(`\nAll symbols (${result.symbols.length}): ${result.symbols.join(', ')}\n`);
    } else {
      process.stdout.write(
        'No symbols matched. Try lowering MIN_COMP_RATING in .env, or re-run `npm run login`.\n',
      );
    }
  } finally {
    await context.close();
  }
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
    case 'schedule':
      throw new Error('`schedule` is not implemented yet (planned in step 5).');
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
