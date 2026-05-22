import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Response } from 'playwright';
import { IBD_STOCK_LIST_URL_PREFIX } from './auth.js';
import { solveHumanChallengeIfPresent } from './human-check.js';

export type StockRow = {
  symbol: string;
  company: string | null;
  compRating: number | null;
  epsRating: number | null;
  rsRating: number | null;
  price: number | null;
  pricePercentChange: number | null;
  rank: number | null;
};

export type ScrapeResult = {
  list: string;
  listId: string;
  url: string;
  symbols: string[];
  rows: StockRow[];
  totalReturned: number;
};

export type PresetList = {
  /**
   * Stable internal id used in logs, debug filenames, and the persisted
   * last-state file. Kept underscored (e.g. `_NewHighs`) for backward
   * compatibility with previous runs of the screener.
   */
  id: string;
  /** Human-readable name used in logs and email summaries. */
  name: string;
  /**
   * URL slug under `research.investors.com/stock-lists/`, e.g. `new-highs`.
   * Also used as a soft hint when picking the right XHR response body for
   * this list (see `pickBestListBody`). When `url` is set the slug is only
   * used as that hint and doesn't drive navigation.
   */
  slug: string;
  /**
   * Optional absolute URL override for lists that don't live under the
   * standard `/stock-lists/<slug>/` path (e.g. Stocks On The Move, which
   * is still served from its legacy `/stocksonthemove.aspx` page).
   */
  url?: string;
};

/**
 * The IBD preset lists we scan. Most have a dedicated page under
 * `research.investors.com/stock-lists/<slug>/`, with a couple of legacy
 * `.aspx` pages mixed in. These are the lists exposed by the "Stock Lists"
 * mega-menu (visible on pages like
 * https://www.investors.com/ibd-indexes/ibd-breakout-stocks-index/) -- we
 * navigate directly instead of driving the menu, which is more robust
 * against header redesigns.
 *
 * (The menu also exposes `Your Weekly Review` and `IBD Data Tables`, but
 * those are subscriber-personalized / non-screener views and are excluded
 * on purpose. `Global Leaders` used to live at
 * `/stock-lists/global-leaders/` but IBD has since retired it.)
 */
export const PRESET_LISTS: readonly PresetList[] = [
  { id: '_IBD50', name: 'IBD 50', slug: 'ibd-50' },
  { id: '_IBDBigCap20', name: 'IBD Big Cap 20', slug: 'big-cap-20' },
  { id: '_SectorLeaders', name: 'Sector Leaders', slug: 'sector-leaders' },
  { id: '_StockSpotlight', name: 'Stock Spotlight', slug: 'stock-spotlight' },
  { id: '_IPOLeaders', name: 'IPO Leaders', slug: 'ipo-leaders' },
  { id: '_NewHighs', name: 'New Highs', slug: 'new-highs' },
  {
    id: '_RelativeStrengthHigh',
    name: 'Stocks With Rising RS',
    slug: 'relative-strength-at-new-high',
  },
  {
    id: '_RisingProfitEstimates',
    name: 'Rising Profit Estimates',
    slug: 'rising-profit-estimates',
  },
  {
    id: '_StocksFundsBuying',
    name: 'Stocks Funds Are Buying',
    slug: 'stocks-that-funds-are-buying',
  },
  {
    // Legacy page that predates the `/stock-lists/<slug>/` template, so we
    // pass an absolute URL override. The slug is kept for symmetry with the
    // other entries and as a hint for `pickBestListBody`.
    id: '_StocksOnTheMove',
    name: 'Stocks On The Move',
    slug: 'stocksonthemove',
    url: 'https://research.investors.com/stocksonthemove.aspx',
  },
];

/** Build the full URL for a preset list page. */
function listUrl(list: PresetList): string {
  return list.url ?? `${IBD_STOCK_LIST_URL_PREFIX}${list.slug}/`;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitLikeHuman(page: Page, minMs: number, maxMs: number): Promise<void> {
  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

/**
 * Heuristic ticker validator (used only as a final fallback / sanity check).
 * - Uppercase letters, with optional internal dot or hyphen (BRK.B, RDS-A)
 * - 1-6 characters total
 * - Must start AND end with a letter (rejects "A-", "U.S.", "WORK.", etc.)
 * - Excludes common false positives (column headers, English words shouting in caps).
 */
const TICKER_RE = /^[A-Z](?:[A-Z.\-]{0,4}[A-Z])?$/;

/**
 * Common English/UI words that match the ticker regex but are obviously not tickers.
 * This catches the noise the user reported (ABOUT, ABOVE, ...) without trying to
 * enumerate every word in the dictionary.
 */
const STOPWORDS = new Set([
  'NEW', 'HIGH', 'HIGHS', 'LOW', 'LOWS', 'STOCK', 'STOCKS', 'IBD', 'EPS', 'PE',
  'RS', 'AC', 'ROE', 'PRICE', 'CHG', 'CHANGE', 'VOL', 'VOLUME', 'COMP', 'SMR',
  'GROUP', 'RANK', 'NAME', 'SYMBOL', 'INDEX', 'YTD', 'WK', 'MO', 'QTR', 'YR',
  'A', 'B', 'C', 'D', 'E', 'I', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
  'AM', 'PM', 'ET', 'PT', 'PST', 'PDT', 'EST', 'EDT', 'USD', 'NYSE', 'NASDAQ',
  'OK', 'NO', 'YES', 'BUY', 'SELL', 'HOLD',
  'ABOUT', 'ABOVE', 'AFTER', 'AGAIN', 'ALL', 'ALSO', 'AND', 'ANY', 'ARE',
  'BACK', 'BEEN', 'BEFORE', 'BELOW', 'BEST', 'BOTH', 'BUT', 'BY',
  'CAN', 'CLICK', 'CLOSE', 'COM', 'COULD', 'DATA', 'DAY', 'DAYS', 'DOES',
  'DONE', 'DOWN', 'DURING', 'EACH', 'EDIT', 'END', 'EVEN', 'EVER', 'EVERY',
  'FEW', 'FOR', 'FROM', 'FULL', 'GET', 'GO', 'GOOD', 'HAD', 'HAS', 'HAVE',
  'HELP', 'HER', 'HERE', 'HIM', 'HIS', 'HOME', 'HOT', 'HOW', 'HOUR', 'INTO',
  'IT', 'ITS', 'JUST', 'KEY', 'LAST', 'LESS', 'LIKE', 'LIST', 'LIVE', 'LONG',
  'LOOK', 'MADE', 'MAIN', 'MAKE', 'MANY', 'MAP', 'MAX', 'MAY', 'MENU', 'MIN',
  'MORE', 'MOST', 'MUCH', 'MY', 'NEAR', 'NEED', 'NEXT', 'NONE', 'NOR', 'NOT',
  'NOW', 'OF', 'OFF', 'ON', 'ONE', 'ONLY', 'OPEN', 'OR', 'OTHER', 'OUR',
  'OUT', 'OVER', 'OWN', 'PAGE', 'PART', 'PAST', 'PER', 'PICK', 'PLAY', 'PLUS',
  'PRO', 'PUT', 'QUICK', 'READ', 'REAL', 'SAME', 'SAVE', 'SEE', 'SET', 'SHOW',
  'SIDE', 'SINCE', 'SIZE', 'SO', 'SOME', 'SOON', 'SORT', 'STAR', 'STILL',
  'STOP', 'SUCH', 'SUM', 'TAB', 'TAP', 'TEXT', 'THAN', 'THAT', 'THE',
  'THEIR', 'THEM', 'THEN', 'THERE', 'THESE', 'THEY', 'THIS', 'THOSE', 'TIME',
  'TIPS', 'TO', 'TODAY', 'TOOL', 'TOP', 'TRY', 'TWO', 'UNDER', 'UNTIL', 'UP',
  'USE', 'USER', 'VERY', 'VIA', 'VIEW', 'WANT', 'WAS', 'WAY', 'WE', 'WEB',
  'WEEK', 'WELL', 'WENT', 'WERE', 'WHAT', 'WHEN', 'WHERE', 'WHICH', 'WHILE',
  'WHO', 'WHY', 'WILL', 'WITH', 'WORK', 'YEAR', 'YOU', 'YOUR', 'ZONE',
  'INC', 'CORP', 'LTD', 'LLC', 'CO', 'PLC', 'NA', 'NM', 'NMS', 'OTC',
  'IPO', 'ETF', 'ADR', 'AI', 'ML', 'API', 'URL', 'JSON', 'CSV', 'PDF',
  'GO', 'AGO', 'OLD', 'BIG', 'TOP', 'HIT',
]);

function looksLikeTicker(s: string): boolean {
  if (!TICKER_RE.test(s)) return false;
  if (STOPWORDS.has(s)) return false;
  return true;
}

/**
 * Patterns we recognize in `<a href>` values that point to a stock-detail page.
 * The captured group is the ticker. Each pattern is tried in order.
 */
const QUOTE_HREF_PATTERNS: RegExp[] = [
  /[?&]symbol=([A-Za-z][A-Za-z.\-]{0,5})\b/i,
  /[?&]ticker=([A-Za-z][A-Za-z.\-]{0,5})\b/i,
  /\/research\/([A-Za-z][A-Za-z.\-]{0,5})(?:[\/?#]|$)/i,
  /\/quote\/([A-Za-z][A-Za-z.\-]{0,5})(?:[\/?#]|$)/i,
  /\/stock-quotes?\/([A-Za-z][A-Za-z.\-]{0,5})(?:[\/?#]|$)/i,
  /\/stocks?\/([A-Za-z][A-Za-z.\-]{0,5})(?:[\/?#]|$)/i,
];

function extractTickerFromHref(href: string): string | null {
  for (const re of QUOTE_HREF_PATTERNS) {
    const m = href.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return null;
}

/**
 * Navigate directly to the given preset list's page on
 * `research.investors.com/stock-lists/<slug>/`.
 *
 * IBD's standalone `ibdstockscreener.investors.com` SPA was retired; the
 * canonical entry points for the lists are now the per-list pages reachable
 * from the "Stock Lists" mega-menu in the site header (visible on pages
 * such as https://www.investors.com/ibd-indexes/ibd-breakout-stocks-index/).
 * Going directly to the URL is faster and more robust than driving that
 * menu, and the underlying XHR that populates the table fires either way.
 */
async function gotoIbdList(page: Page, list: PresetList): Promise<void> {
  const url = listUrl(list);
  await waitLikeHuman(page, 3_000, 5_000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // IBD's CDN sometimes serves a PerimeterX "Please verify you are a human"
  // page instead of the list. Try to clear it (auto, then manual) before
  // we wait for table content -- otherwise `waitForRows` would just spin
  // for 60 s on a captcha page.
  await solveHumanChallengeIfPresent(page);

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await waitLikeHuman(page, 5_000, 8_000);

  // The list table is rendered after an XHR resolves. Wait until the table
  // is actually populated -- `networkidle` isn't enough because IBD pings
  // analytics continuously. We poll for a meaningful row count instead and
  // tolerate timeouts because the JSON capture path can still succeed even
  // when the DOM table never renders.
  await waitForRows(page, { minRows: 5, timeoutMs: 60_000 });
  await waitLikeHuman(page, 3_000, 5_000);
}

/**
 * Poll until the screener has at least `minRows` data rows rendered, or the
 * timeout elapses. Tries a few selectors so it works whether IBD uses an
 * Ant Design table, plain `<table>`, or ARIA grid markup.
 */
async function waitForRows(
  page: Page,
  options: { minRows: number; timeoutMs: number; pollMs?: number },
): Promise<number> {
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;
  const rowSelectors = [
    '.ant-table-tbody tr.ant-table-row',
    '.ant-table-tbody > tr',
    'tbody tr',
    '[role="row"]:not([role="row"][aria-rowindex="1"])',
  ];

  let last = 0;
  while (Date.now() < deadline) {
    let best = 0;
    for (const sel of rowSelectors) {
      const n = await page.locator(sel).count().catch(() => 0);
      if (n > best) best = n;
    }
    if (best >= options.minRows) {
      process.stdout.write(`Detected ${best} table rows.\n`);
      return best;
    }
    if (best !== last) {
      process.stdout.write(`Waiting for rows ... currently ${best}\n`);
      last = best;
    }
    await page.waitForTimeout(pollMs);
  }
  process.stderr.write(
    `warning: timed out waiting for rows after ${options.timeoutMs} ms (last seen: ${last}).\n`,
  );
  return last;
}

/**
 * Extract ticker symbols from the current page.
 *
 * We try three structured strategies in order, from most-precise to least-precise.
 * As soon as one returns at least one symbol, we use it. If none match, we return
 * an empty list rather than fall back to a text scan -- the text scan produces
 * too much noise (company-name tokens, UI words) to be useful.
 *
 *   1. IBD's own ticker markup: <span class="stockSymbol"><a>AAPL</a></span>.
 *   2. Anchor links whose href points to a stock-detail page (e.g. /research/AAPL/,
 *      ?symbol=AAPL).
 *   3. The cells of any <table> column whose header looks like "Symbol" / "Ticker".
 */
async function extractSymbolsFromPage(page: Page): Promise<string[]> {
  const fromStockSymbol = await extractFromStockSymbolMarkup(page);
  if (fromStockSymbol.length > 0) return fromStockSymbol;

  const fromHrefs = await extractFromQuoteLinks(page);
  if (fromHrefs.length > 0) return fromHrefs;

  const fromSymbolColumn = await extractFromSymbolColumn(page);
  if (fromSymbolColumn.length > 0) return fromSymbolColumn;

  return [];
}

async function extractFromStockSymbolMarkup(page: Page): Promise<string[]> {
  const texts = await page
    .$$eval('span.stockSymbol a, span.stockSymbol', (nodes: Element[]) =>
      nodes.map((n) => (n.textContent ?? '').trim()).filter((t) => t.length > 0),
    )
    .catch(() => [] as string[]);

  const seen = new Set<string>();
  for (const raw of texts) {
    const token = raw.toUpperCase().split(/\s+/)[0] ?? '';
    if (TICKER_RE.test(token)) seen.add(token);
  }
  return [...seen].sort();
}

async function extractFromQuoteLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .$$eval('a[href]', (anchors: Element[]) =>
      anchors
        .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
        .filter((h) => h.length > 0),
    )
    .catch(() => [] as string[]);

  const seen = new Set<string>();
  for (const href of hrefs) {
    const ticker = extractTickerFromHref(href);
    if (ticker && looksLikeTicker(ticker)) seen.add(ticker);
  }
  return [...seen].sort();
}

async function extractFromSymbolColumn(page: Page): Promise<string[]> {
  const cellsByTable = await page
    .$$eval('table', (tables: Element[]) => {
      const out: string[][] = [];
      for (const table of tables) {
        const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th'));
        const symbolIdx = headers.findIndex((th) =>
          /^(symbol|ticker)$/i.test((th.textContent ?? '').trim()),
        );
        if (symbolIdx < 0) continue;

        const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
        const colCells: string[] = [];
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          const cell = cells[symbolIdx];
          if (cell) colCells.push((cell.textContent ?? '').trim());
        }
        if (colCells.length > 0) out.push(colCells);
      }
      return out;
    })
    .catch(() => [] as string[][]);

  const seen = new Set<string>();
  for (const column of cellsByTable) {
    for (const raw of column) {
      const token = raw.toUpperCase().split(/\s+/)[0] ?? '';
      if (looksLikeTicker(token)) seen.add(token);
    }
  }
  return [...seen].sort();
}

export type ScrapeOptions = {
  debugDir?: string;
  /**
   * Minimum IBD Composite Rating to include. IBD's own UI default for the
   * New Highs list is `>= 94` (matches the .xls export from their site).
   * Pass `0` to include every stock with any rating.
   */
  minCompRating?: number;
  /**
   * Cap on the number of rows returned, after sorting by Composite Rating.
   * IBD's UI/export caps at 100 stocks. Pass `0` for no cap.
   */
  maxResults?: number;
};

export async function scrapeIbdList(
  context: BrowserContext,
  list: PresetList,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const minCompRating = options.minCompRating ?? 94;
  const maxResults = options.maxResults ?? 100;
  const page = await context.newPage();

  // IBD's list pages render rows via custom widgets, so the symbols never
  // appear in the DOM as plain text. They DO arrive over the wire as JSON,
  // though, so we listen to every response while navigating and harvest
  // both raw bodies and the symbols inside them. We then pick the best body
  // by content shape (most rows with `comp_rating`) rather than by URL --
  // that way a future endpoint rename doesn't break us.
  const captured: Array<{
    url: string;
    symbols: string[];
    sample: unknown;
    body?: unknown;
    parsedRowCount: number;
  }> = [];
  const onResponse = async (response: Response): Promise<void> => {
    try {
      const rt = response.request().resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;
      const ct = (response.headers()['content-type'] ?? '').toLowerCase();
      if (!ct.includes('json')) return;
      const body = await response.json().catch(() => null);
      if (!body) return;
      const symbols = harvestSymbolsFromJson(body);
      if (symbols.length === 0) return;
      const parsedRowCount = parseListRows(body).length;
      // Only retain the full body for payloads that look like a list of
      // stocks with fundamentals -- otherwise we'd hold onto megabytes of
      // unrelated widget JSON (charts, news cards, etc.).
      const isListLike = parsedRowCount >= 5;
      captured.push({
        url: response.url(),
        symbols,
        sample: Array.isArray(body) ? body.slice(0, 1) : pickSample(body),
        body: isListLike ? body : undefined,
        parsedRowCount,
      });
    } catch {
      /* ignore */
    }
  };
  page.on('response', onResponse);

  try {
    await gotoIbdList(page, list);
    const url = page.url();

    // Give late XHRs a moment to land.
    await waitLikeHuman(page, 3_000, 5_000);

    if (options.debugDir) {
      await dumpDebugArtifacts(page, options.debugDir, list, captured);
    }

    page.off('response', onResponse);

    // Prefer the structured list payload (filtered to actual stocks with
    // fundamentals -- this drops ETFs/funds that print no `comp_rating`).
    // Among multiple list-shaped bodies, pick the one with the most rows;
    // tiebreak by URL containing the list slug as a hint.
    const listBody = pickBestListBody(captured, list);
    if (listBody !== undefined) {
      const allStocks = parseListRows(listBody);
      const sorted = allStocks
        .filter((r) => (r.compRating ?? 0) >= minCompRating)
        .sort((a, b) => {
          const c = (b.compRating ?? 0) - (a.compRating ?? 0);
          if (c !== 0) return c;
          // Tie-break: higher RS rating first (IBD-ish ordering).
          return (b.rsRating ?? 0) - (a.rsRating ?? 0);
        });
      const capped = maxResults > 0 ? sorted.slice(0, maxResults) : sorted;
      return {
        list: list.name,
        listId: list.id,
        url,
        symbols: capped.map((r) => r.symbol),
        rows: capped,
        totalReturned: countTotalRows(listBody),
      };
    }

    let symbols = pickBestSymbolPayload(captured);
    if (symbols.length === 0) {
      symbols = await extractSymbolsFromPage(page);
    }
    return {
      list: list.name,
      listId: list.id,
      url,
      symbols,
      rows: [],
      totalReturned: 0,
    };
  } finally {
    page.off('response', onResponse);
    await page.close();
  }
}

/**
 * Choose the captured JSON body that most likely represents the list's
 * stock table. Picks the body with the most parsed rows; if there's a tie,
 * prefer the URL that mentions the list's slug.
 */
function pickBestListBody(
  captured: Array<{ url: string; body?: unknown; parsedRowCount: number }>,
  list: PresetList,
): unknown | undefined {
  const withBody = captured.filter((c) => c.body !== undefined);
  if (withBody.length === 0) return undefined;
  const slugRe = new RegExp(list.slug.replace(/-/g, '[-_]?'), 'i');
  const idRe = new RegExp(list.id.replace(/^_/, ''), 'i');
  withBody.sort((a, b) => {
    if (b.parsedRowCount !== a.parsedRowCount) {
      return b.parsedRowCount - a.parsedRowCount;
    }
    const aHint = slugRe.test(a.url) || idRe.test(a.url) ? 1 : 0;
    const bHint = slugRe.test(b.url) || idRe.test(b.url) ? 1 : 0;
    return bHint - aHint;
  });
  return withBody[0]?.body;
}

/**
 * Scrape every preset list, one after another. Failures on individual lists
 * are logged but don't abort the run -- aggregation across the remaining
 * lists is still useful.
 */
export async function scrapeAllLists(
  context: BrowserContext,
  options: ScrapeOptions = {},
): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];
  for (const list of PRESET_LISTS) {
    process.stdout.write(`\n--- Scraping ${list.name} (${list.id}) ---\n`);
    try {
      const result = await scrapeIbdList(context, list, options);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error scraping ${list.name}: ${message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, randomBetween(6_000, 10_000)));
  }
  return results;
}

/**
 * Parse an `_{List}` API response into typed rows, keeping only entries
 * with a populated `comp_rating` (i.e. stocks with IBD fundamentals -- this
 * filters out ETFs / funds, which print as `null` for ratings).
 */
function parseListRows(body: unknown): StockRow[] {
  const list = extractStockList(body);
  const out: StockRow[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : '';
    if (!TICKER_RE.test(symbol)) continue;
    if (row.comp_rating == null) continue; // drop ETFs / funds
    out.push({
      symbol,
      company: typeof row.company === 'string' ? row.company : null,
      compRating: typeof row.comp_rating === 'number' ? row.comp_rating : null,
      epsRating: typeof row.eps_rating === 'number' ? row.eps_rating : null,
      rsRating: typeof row.rs_rating === 'number' ? row.rs_rating : null,
      price: typeof row.price === 'number' ? row.price : null,
      pricePercentChange:
        typeof row.price_percent_change === 'number' ? row.price_percent_change : null,
      rank: typeof row.rank === 'number' ? row.rank : null,
    });
  }
  return out;
}

function extractStockList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.stock_list)) return obj.stock_list;
    if (Array.isArray(obj.stocks)) return obj.stocks;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

function countTotalRows(body: unknown): number {
  if (body && typeof body === 'object') {
    const info = (body as { info?: { total?: unknown } }).info;
    if (info && typeof info.total === 'number') return info.total;
  }
  return extractStockList(body).length;
}

/**
 * Walk a JSON value and return ticker strings found under explicit symbol-bearing
 * keys (`symbol`, `ticker`, etc.). We deliberately do NOT accept arbitrary
 * string values: API responses contain dozens of incidental short uppercase
 * strings (rating labels like "A+", category names like "FUNDS", config keys
 * like "MM" / "WEEKLY") that would otherwise show up as fake tickers.
 */
function harvestSymbolsFromJson(value: unknown): string[] {
  const out = new Set<string>();
  const SYMBOL_KEYS = new Set(['symbol', 'ticker', 'Symbol', 'Ticker', 'sym', 'SYM']);

  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (SYMBOL_KEYS.has(k) && typeof child === 'string') {
          const s = child.trim().toUpperCase();
          if (TICKER_RE.test(s)) out.add(s);
        } else {
          visit(child);
        }
      }
    }
  };
  visit(value);
  return [...out];
}

/**
 * Among all JSON responses that yielded symbols, prefer the one with the most
 * symbols. (The New Highs payload should dwarf incidental stuff like
 * "trending" widgets or watchlists.)
 */
function pickBestSymbolPayload(
  captured: Array<{ url: string; symbols: string[] }>,
): string[] {
  if (captured.length === 0) return [];
  const best = captured.reduce((a, b) => (b.symbols.length > a.symbols.length ? b : a));
  return [...best.symbols].sort();
}

function pickSample(obj: Record<string, unknown>): unknown {
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length > 0) return v.slice(0, 1);
  }
  return obj;
}

/**
 * Persist the rendered page so we can figure out the right selectors offline.
 * All files are namespaced by the list id (e.g. `debug-NewHighs-page.html`)
 * so per-list debug runs don't clobber each other:
 *   - debug-<list>-page.html : full DOM as the user sees it
 *   - debug-<list>-page.png  : full-page screenshot
 *   - debug-<list>-selector-counts.txt : how many nodes match each candidate selector
 *   - debug-<list>-network.json : XHR/fetch responses that contained ticker-shaped strings
 *   - debug-<list>-raw.json  : full list-API response, if captured
 */
async function dumpDebugArtifacts(
  page: Page,
  outDir: string,
  list: PresetList,
  captured: Array<{
    url: string;
    symbols: string[];
    sample: unknown;
    body?: unknown;
    parsedRowCount?: number;
  }> = [],
): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  // Strip the leading underscore so filenames read "debug-NewHighs-..." rather
  // than "debug-_NewHighs-...".
  const slug = list.id.replace(/^_/, '');
  const prefix = `debug-${slug}`;

  const candidateSelectors = [
    'span.stockSymbol',
    'span.stockSymbol a',
    'a.stockSymbol',
    '.stock-symbol',
    '.stock-symbol a',
    '.symbol',
    '.symbol a',
    '.ticker',
    '.ticker a',
    '[data-symbol]',
    '[data-ticker]',
    'a[href*="symbol="]',
    'a[href*="/research/"]',
    'a[href*="/quote/"]',
    'tbody tr',
    '.ant-table-row',
    '.ant-table-cell',
    '.ant-table-tbody tr',
    '.ant-table-tbody td',
    '.symbol-cell',
    '.symbolCell',
    'td[class*="symbol" i]',
    'td[class*="ticker" i]',
    'span[class*="symbol" i]',
    'a[class*="symbol" i]',
    '.cell-symbol',
    '[role="row"]',
    '[role="cell"]',
  ];

  const counts: Record<string, number> = {};
  for (const sel of candidateSelectors) {
    counts[sel] = await page.locator(sel).count().catch(() => 0);
  }

  const html = await page.content();
  await fs.writeFile(path.join(outDir, `${prefix}-page.html`), html, 'utf8');

  await page
    .screenshot({ path: path.join(outDir, `${prefix}-page.png`), fullPage: true })
    .catch(() => {});

  const summary = Object.entries(counts)
    .map(([sel, n]) => `${n.toString().padStart(5)}  ${sel}`)
    .join('\n');
  await fs.writeFile(
    path.join(outDir, `${prefix}-selector-counts.txt`),
    `URL: ${page.url()}\n\nSelector match counts:\n${summary}\n`,
    'utf8',
  );

  const networkSummary = captured
    .map((c) => ({
      url: c.url,
      symbolCount: c.symbols.length,
      parsedRowCount: c.parsedRowCount ?? 0,
      hasBody: c.body !== undefined,
      firstSymbols: c.symbols.slice(0, 10),
      sample: c.sample,
    }))
    .sort((a, b) => {
      const rc = (b.parsedRowCount ?? 0) - (a.parsedRowCount ?? 0);
      if (rc !== 0) return rc;
      return b.symbolCount - a.symbolCount;
    });
  await fs.writeFile(
    path.join(outDir, `${prefix}-network.json`),
    JSON.stringify(networkSummary, null, 2),
    'utf8',
  );

  const rawCapture = pickBestListBody(
    captured.map((c) => ({
      url: c.url,
      body: c.body,
      parsedRowCount: c.parsedRowCount ?? 0,
    })),
    list,
  );
  if (rawCapture !== undefined) {
    await fs.writeFile(
      path.join(outDir, `${prefix}-raw.json`),
      JSON.stringify(rawCapture, null, 2),
      'utf8',
    );
  }

  process.stdout.write(
    [
      '',
      `Debug artifacts for ${list.name} written to ${outDir}:`,
      `  - ${prefix}-page.html`,
      `  - ${prefix}-page.png`,
      `  - ${prefix}-selector-counts.txt`,
      `  - ${prefix}-network.json`,
      `  - ${prefix}-raw.json (full ${list.id} API response, if captured)`,
      '',
    ].join('\n'),
  );
}
