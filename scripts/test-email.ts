/**
 * One-off email smoke test. Loads `.env` via `loadConfig()`, sends a tiny
 * message, and prints what nodemailer accepted / rejected. Useful for
 * verifying multi-recipient EMAIL_TO without running the full scrape.
 *
 * Run with:  npx tsx scripts/test-email.ts
 */
import { loadConfig } from '../src/config.js';
import { sendSummary } from '../src/email.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const stamp = new Date().toISOString();

  process.stdout.write(`To      : ${config.email.to.join(', ')}\n`);
  process.stdout.write(`From    : ${config.email.from}\n`);
  process.stdout.write(`Count   : ${config.email.to.length} recipient(s)\n\n`);

  const info = await sendSummary(config.email, {
    subject: `IBD Screener — test email ${stamp}`,
    text: `This is a test email from scripts/test-email.ts at ${stamp}.\n`,
    html: `<p>This is a <strong>test email</strong> from <code>scripts/test-email.ts</code> at ${stamp}.</p>`,
  });

  process.stdout.write(`Sent    : accepted=${info.accepted.join(',') || '(none)'}\n`);
  if (info.rejected.length > 0) {
    process.stdout.write(`Rejected: ${info.rejected.join(',')}\n`);
  }
  process.stdout.write(`Id      : ${info.messageId}\n`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`test-email failed: ${message}\n`);
  process.exit(1);
});
