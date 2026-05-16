import nodemailer from 'nodemailer';
import type { ScrapeResult } from './scrape.js';
import type { AggregationResult, SymbolAppearance } from './aggregate.js';

export type EmailConfig = {
  user: string;
  appPassword: string;
  /** One or more recipient addresses. Nodemailer accepts a string[] directly. */
  to: string[];
  from: string;
};

export type EmailFilters = {
  minCompRating: number;
  maxResults: number;
  minListCount: number;
};

export type EmailContent = {
  subject: string;
  text: string;
  html: string;
};

export type SendResult = {
  messageId: string;
  accepted: readonly string[];
  rejected: readonly string[];
};

/**
 * Pure formatter: turn the scrape + aggregation into a ready-to-send message.
 * Separating this from `sendSummary` lets us unit-test the output and also
 * dry-run the email in the CLI without touching the network.
 */
export function buildEmailContent(
  scrapes: ScrapeResult[],
  aggregation: AggregationResult,
  filters: EmailFilters,
): EmailContent {
  const dateStr = aggregation.runAt.slice(0, 10);
  const newcomerPart = aggregation.hasPreviousRun
    ? `, ${aggregation.newcomers.length} new`
    : '';
  const subject =
    `IBD Screener ${dateStr} — ${aggregation.appearances.length} on ` +
    `${aggregation.minListCount}+ lists${newcomerPart}`;

  return {
    subject,
    text: buildPlainText(scrapes, aggregation, filters),
    html: buildHtml(scrapes, aggregation, filters),
  };
}

export async function sendSummary(
  cfg: EmailConfig,
  content: EmailContent,
): Promise<SendResult> {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.user, pass: cfg.appPassword },
  });
  const info = await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []) as readonly string[],
    rejected: (info.rejected ?? []) as readonly string[],
  };
}

// ---------------------------------------------------------------------------
// Plain-text body
// ---------------------------------------------------------------------------

function buildPlainText(
  scrapes: ScrapeResult[],
  aggregation: AggregationResult,
  filters: EmailFilters,
): string {
  const lines: string[] = [];
  lines.push(`IBD Screener summary — ${aggregation.runAt}`);
  lines.push(
    `Filters: Composite Rating >= ${filters.minCompRating}, ` +
      `capped at ${filters.maxResults || '\u221e'} per list, ` +
      `aggregated at >= ${filters.minListCount} lists`,
  );
  lines.push('');

  lines.push('--- Per-list counts ---');
  for (const s of scrapes) {
    lines.push(
      `  ${s.list.padEnd(26)} ${String(s.symbols.length).padStart(4)} symbols` +
        (s.totalReturned > 0 ? ` (of ${s.totalReturned})` : ''),
    );
  }
  lines.push('');

  lines.push(
    `--- Symbols on >= ${aggregation.minListCount} lists (${aggregation.appearances.length}) ---`,
  );
  if (aggregation.appearances.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push(
      `  ${'Sym'.padEnd(6)} ${'Company'.padEnd(28)} N  Comp EPS  RS   Price   Lists`,
    );
    for (const a of aggregation.appearances) {
      lines.push(`  ${formatAppearanceText(a)}`);
    }
  }
  lines.push('');

  lines.push('--- Diff vs previous run ---');
  if (!aggregation.hasPreviousRun) {
    lines.push('  No previous run on file. This run establishes the baseline.');
  } else {
    lines.push(
      `  Newcomers  (${aggregation.newcomers.length}): ` +
        (aggregation.newcomers.length > 0 ? aggregation.newcomers.join(', ') : '(none)'),
    );
    lines.push(
      `  Departures (${aggregation.departures.length}): ` +
        (aggregation.departures.length > 0
          ? aggregation.departures.join(', ')
          : '(none)'),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function formatAppearanceText(a: SymbolAppearance): string {
  return (
    `${a.symbol.padEnd(6)} ${(a.company ?? '').slice(0, 28).padEnd(28)} ` +
    `${String(a.listCount).padStart(1)}  ` +
    `${String(a.compRating ?? '-').padStart(3)}  ` +
    `${String(a.epsRating ?? '-').padStart(3)}  ` +
    `${String(a.rsRating ?? '-').padStart(3)}  ` +
    `${(a.price ?? 0).toFixed(2).padStart(7)}  ` +
    `${a.lists.join(', ')}`
  );
}

// ---------------------------------------------------------------------------
// HTML body
// ---------------------------------------------------------------------------

/**
 * Minimal HTML escape for untrusted strings (company names, etc.). Not a
 * general-purpose escape -- we only interpolate short plain strings here,
 * not attribute values that need quote handling.
 */
function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHtml(
  scrapes: ScrapeResult[],
  aggregation: AggregationResult,
  filters: EmailFilters,
): string {
  const newcomerSet = new Set(aggregation.newcomers);
  const perListRows = scrapes
    .map(
      (s) => `
      <tr>
        <td>${esc(s.list)}</td>
        <td style="text-align:right">${s.symbols.length}</td>
        <td style="text-align:right;color:#777">${s.totalReturned || ''}</td>
      </tr>`,
    )
    .join('');

  const aggRows =
    aggregation.appearances.length === 0
      ? `<tr><td colspan="8" style="color:#777;font-style:italic">No symbols matched at >= ${aggregation.minListCount} lists.</td></tr>`
      : aggregation.appearances
          .map((a) => {
            const isNew = newcomerSet.has(a.symbol);
            const rowStyle = isNew
              ? 'background:#fffbe6;border-left:3px solid #faad14'
              : '';
            const newBadge = isNew
              ? ' <span style="font-size:10px;background:#faad14;color:#fff;padding:1px 6px;border-radius:3px;vertical-align:middle">NEW</span>'
              : '';
            return `
      <tr style="${rowStyle}">
        <td><strong>${esc(a.symbol)}</strong>${newBadge}</td>
        <td>${esc(a.company)}</td>
        <td style="text-align:right">${a.listCount}</td>
        <td style="text-align:right">${a.compRating ?? '-'}</td>
        <td style="text-align:right">${a.epsRating ?? '-'}</td>
        <td style="text-align:right">${a.rsRating ?? '-'}</td>
        <td style="text-align:right">${(a.price ?? 0).toFixed(2)}</td>
        <td style="color:#555;font-size:12px">${esc(a.lists.join(', '))}</td>
      </tr>`;
          })
          .join('');

  const diffBlock = !aggregation.hasPreviousRun
    ? `<p style="color:#777"><em>No previous run on file. This run establishes the baseline.</em></p>`
    : `
      <p><strong>Newcomers (${aggregation.newcomers.length}):</strong> ${
        aggregation.newcomers.length > 0
          ? aggregation.newcomers
              .map((s) => `<code>${esc(s)}</code>`)
              .join(', ')
          : '<span style="color:#777">(none)</span>'
      }</p>
      <p><strong>Departures (${aggregation.departures.length}):</strong> ${
        aggregation.departures.length > 0
          ? aggregation.departures
              .map((s) => `<code style="color:#888">${esc(s)}</code>`)
              .join(', ')
          : '<span style="color:#777">(none)</span>'
      }</p>`;

  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;max-width:960px;margin:0 auto;padding:16px">
    <h2 style="margin-bottom:4px">IBD Screener — ${esc(aggregation.runAt.slice(0, 10))}</h2>
    <p style="color:#777;margin-top:0">
      Composite Rating &ge; ${filters.minCompRating},
      capped at ${filters.maxResults || '&infin;'} per list,
      aggregated at &ge; ${filters.minListCount} lists.
    </p>

    <h3>Diff vs previous run</h3>
    ${diffBlock}

    <h3>Symbols on &ge; ${aggregation.minListCount} lists
      <span style="color:#777;font-weight:normal">(${aggregation.appearances.length})</span>
    </h3>
    <table cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5;text-align:left">
          <th>Sym</th><th>Company</th>
          <th style="text-align:right">N</th>
          <th style="text-align:right">Comp</th>
          <th style="text-align:right">EPS</th>
          <th style="text-align:right">RS</th>
          <th style="text-align:right">Price</th>
          <th>Lists</th>
        </tr>
      </thead>
      <tbody>${aggRows}
      </tbody>
    </table>

    <h3 style="margin-top:24px">Per-list counts</h3>
    <table cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5;text-align:left">
          <th>List</th>
          <th style="text-align:right">Symbols (filtered)</th>
          <th style="text-align:right">Total in list</th>
        </tr>
      </thead>
      <tbody>${perListRows}
      </tbody>
    </table>
  </body>
</html>`;
}
