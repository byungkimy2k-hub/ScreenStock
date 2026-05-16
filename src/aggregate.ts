import fs from 'node:fs/promises';
import { z } from 'zod';
import type { ScrapeResult, StockRow } from './scrape.js';

/**
 * A single symbol's fingerprint across the lists it was found on.
 * The rating/price fields come from the FIRST list (in scrape order) that
 * reported a non-null value -- IBD publishes the same rating in every list
 * it syndicates to, so this is effectively just "the rating".
 */
export type SymbolAppearance = {
  symbol: string;
  company: string | null;
  compRating: number | null;
  epsRating: number | null;
  rsRating: number | null;
  price: number | null;
  pricePercentChange: number | null;
  /** Human-readable list names, in scrape order. */
  lists: string[];
  /** List ids (e.g. `_IBD50`), parallel to `lists`. */
  listIds: string[];
  listCount: number;
};

export type AggregationResult = {
  /** ISO-8601 timestamp of the run that produced this result. */
  runAt: string;
  /** The `listCount >= minListCount` threshold used to pick `appearances`. */
  minListCount: number;
  /** Symbols that appeared in at least `minListCount` preset lists. */
  appearances: SymbolAppearance[];
  /** Symbols in the aggregated set now but not in the previous run. */
  newcomers: string[];
  /** Symbols in the previous aggregated set but no longer in this one. */
  departures: string[];
  /** Whether a previous state file was found at all. */
  hasPreviousRun: boolean;
};

/**
 * Persisted state file. Versioned so we can evolve the shape without
 * blowing up on old files -- unknown/invalid content is treated as "no
 * previous run" and silently replaced on the next save.
 */
const LastStateSchema = z.object({
  version: z.literal(1),
  runAt: z.string(),
  minListCount: z.number().int().min(1),
  symbols: z.array(z.string()),
});
export type LastState = z.infer<typeof LastStateSchema>;

/**
 * Fold `ScrapeResult[]` into per-symbol appearances, then keep only symbols
 * that showed up on `>= minListCount` lists. Sorted by list-count desc, with
 * Composite Rating as the tie-breaker (the IBD-ish ordering).
 */
export function aggregateLists(
  results: ScrapeResult[],
  options: { minListCount?: number } = {},
): {
  runAt: string;
  minListCount: number;
  appearances: SymbolAppearance[];
} {
  const minListCount = options.minListCount ?? 2;
  const bySymbol = new Map<string, SymbolAppearance>();

  for (const result of results) {
    // Index this list's rows by symbol so we can enrich the appearance with
    // ratings/price when available. Lists where the structured XHR body
    // wasn't recognized (or its fields were renamed by IBD) come through
    // with `rows: []` and only a populated `symbols` array -- those still
    // count as appearances, just without ratings.
    const rowBySymbol = new Map<string, StockRow>();
    for (const row of result.rows) rowBySymbol.set(row.symbol, row);

    for (const symbol of result.symbols) {
      const row = rowBySymbol.get(symbol);
      const existing = bySymbol.get(symbol);
      if (existing) {
        if (!existing.listIds.includes(result.listId)) {
          existing.lists.push(result.list);
          existing.listIds.push(result.listId);
          existing.listCount = existing.listIds.length;
        }
        if (row) {
          existing.company ??= row.company;
          existing.compRating ??= row.compRating;
          existing.epsRating ??= row.epsRating;
          existing.rsRating ??= row.rsRating;
          existing.price ??= row.price;
          existing.pricePercentChange ??= row.pricePercentChange;
        }
      } else {
        bySymbol.set(symbol, {
          symbol,
          company: row?.company ?? null,
          compRating: row?.compRating ?? null,
          epsRating: row?.epsRating ?? null,
          rsRating: row?.rsRating ?? null,
          price: row?.price ?? null,
          pricePercentChange: row?.pricePercentChange ?? null,
          lists: [result.list],
          listIds: [result.listId],
          listCount: 1,
        });
      }
    }
  }

  const appearances = [...bySymbol.values()]
    .filter((a) => a.listCount >= minListCount)
    .sort((a, b) => {
      if (b.listCount !== a.listCount) return b.listCount - a.listCount;
      return (b.compRating ?? 0) - (a.compRating ?? 0);
    });

  return {
    runAt: new Date().toISOString(),
    minListCount,
    appearances,
  };
}

/** Newcomers = in `current` but not in `previous`. Departures = the reverse. */
export function diffSymbols(
  current: readonly string[],
  previous: readonly string[] | null,
): { newcomers: string[]; departures: string[] } {
  if (previous === null) {
    return { newcomers: [...current].sort(), departures: [] };
  }
  const prev = new Set(previous);
  const curr = new Set(current);
  const newcomers = [...curr].filter((s) => !prev.has(s)).sort();
  const departures = [...prev].filter((s) => !curr.has(s)).sort();
  return { newcomers, departures };
}

/**
 * Read the last-run state file. Returns null if the file doesn't exist or is
 * corrupt / schema-mismatched (both are treated as "no previous run").
 */
export async function loadLastState(path: string): Promise<LastState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = LastStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveLastState(path: string, state: LastState): Promise<void> {
  await fs.writeFile(path, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * End-to-end helper used by the CLI: aggregate, diff against the on-disk
 * state file, persist the new state, return a fully-populated result.
 */
export async function aggregateAndDiff(
  results: ScrapeResult[],
  lastStateFile: string,
  options: { minListCount?: number } = {},
): Promise<AggregationResult> {
  const agg = aggregateLists(results, options);
  const symbols = agg.appearances.map((a) => a.symbol);

  const previous = await loadLastState(lastStateFile);
  const { newcomers, departures } = diffSymbols(symbols, previous?.symbols ?? null);

  await saveLastState(lastStateFile, {
    version: 1,
    runAt: agg.runAt,
    minListCount: agg.minListCount,
    symbols,
  });

  return {
    runAt: agg.runAt,
    minListCount: agg.minListCount,
    appearances: agg.appearances,
    newcomers,
    departures,
    hasPreviousRun: previous !== null,
  };
}
