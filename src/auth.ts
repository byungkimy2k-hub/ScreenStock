import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppPaths } from './config.js';
import { solveHumanChallengeIfPresent } from './human-check.js';

/**
 * Landing page we use after sign-in to "warm" the authenticated cookie jar.
 * Historically this was the standalone `ibdstockscreener.investors.com` SPA,
 * but IBD has since removed that screener UI in favor of the legacy per-list
 * pages under `research.investors.com/stock-lists/<slug>/`. We point the warm
 * page at the new Stock Lists hub so the login flow ends on a real page.
 */
export const IBD_BASE_URL = 'https://research.investors.com/stock-lists/';
/** Per-list URL prefix. Append a slug like `new-highs/` (with trailing slash). */
export const IBD_STOCK_LIST_URL_PREFIX = 'https://research.investors.com/stock-lists/';
export const IBD_SIGNIN_URL = 'https://myibd.investors.com/secure/signin.aspx';

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function profileDir(paths: AppPaths): string {
  return path.join(paths.dataDir, 'browser-profile');
}

/**
 * Launch a persistent browser context that looks as much like a real user as practical:
 *   - Use the user's installed Google Chrome when available (channel: 'chrome'),
 *     falling back to Playwright's bundled Chromium.
 *   - Persist the entire profile (cookies, localStorage, IndexedDB, service workers)
 *     under data/browser-profile/, so the site sees a returning user.
 *   - Strip a couple of obvious automation tells.
 *
 * Bot-detection frameworks (Akamai, PerimeterX) inspect dozens of signals; this is
 * a "best effort" set, not a guarantee.
 */
async function launchPersistent(
  paths: AppPaths,
  options: { headless: boolean },
): Promise<BrowserContext> {
  await ensureDir(profileDir(paths));

  const launchArgs = {
    headless: options.headless,
    viewport: null,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir(paths), {
      ...launchArgs,
      channel: 'chrome',
    });
  } catch (err) {
    process.stderr.write(
      `note: could not launch installed Chrome (${
        err instanceof Error ? err.message : String(err)
      }); falling back to bundled Chromium.\n`,
    );
    context = await chromium.launchPersistentContext(profileDir(paths), launchArgs);
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  return context;
}

/**
 * Open a HEADED browser pointed at the IBD site so the user can sign in manually,
 * then save the session by closing the window OR pressing Enter in the terminal.
 *
 * Because we use a persistent profile, no separate storageState file is needed -
 * the next call to openAuthenticatedContext() reuses the same profile dir.
 */
export async function loginInteractive(paths: AppPaths): Promise<void> {
  await ensureDir(paths.dataDir);

  const context = await launchPersistent(paths, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());

  process.stdout.write(
    [
      '',
      'A Chromium window has opened.',
      `1. Sign in at: ${IBD_BASE_URL}`,
      '2. Make sure you can see the authenticated screener UI (your account name, etc).',
      '3. Then return here and press ENTER to save the session.',
      '',
      'If you see "Access is temporarily restricted", wait 10-15 minutes before retrying',
      '(IBD may have IP-rate-limited the previous attempt).',
      '',
    ].join('\n'),
  );

  await page.goto(IBD_BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  await waitForEnter('Press ENTER after you are signed in... ');

  process.stdout.write(
    `\nProfile saved at ${path.relative(process.cwd(), profileDir(paths))}\n`,
  );

  await context.close();
}

/**
 * Programmatic login using IBD_USER / IBD_PASSWORD from .env.
 *
 * investors.com uses a plain email + password form (no 2FA), so we can fill it
 * directly. Selectors are tried in order so a small DOM change on IBD's side
 * doesn't immediately break us.
 *
 * If IBD challenges with a captcha, blocked-IP page, or any unexpected screen,
 * we leave the browser open and surface a clear error so the caller can fall
 * back to `loginInteractive`.
 */
export async function loginAutomated(
  paths: AppPaths,
  credentials: { user: string; password: string },
  options: { headless?: boolean } = {},
): Promise<void> {
  await ensureDir(paths.dataDir);

  const context = await launchPersistent(paths, { headless: options.headless ?? false });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    process.stdout.write(`Navigating to ${IBD_SIGNIN_URL} ...\n`);
    await page.goto(IBD_SIGNIN_URL, { waitUntil: 'domcontentloaded' });

    const emailSelectors = [
      'input#username',
      'input[name="username"]',
      'input#Email',
      'input[name="Email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
    ];
    const passwordSelectors = [
      'input#password',
      'input[name="password"]',
      'input#Password',
      'input[name="Password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ];

    process.stdout.write(
      [
        '',
        'If you see a "Verification Required" / slide-to-verify CAPTCHA, or a',
        '"Please verify you are a human" press-and-hold prompt, solve it in',
        'the browser window. The script will wait up to 5 minutes for the',
        'sign-in form to appear, then fill in your credentials automatically.',
        '',
      ].join('\n'),
    );

    // Surface a clear message if the press-and-hold challenge is what's
    // blocking the username form. We don't fail here -- waitForFirstVisible
    // below will keep polling regardless.
    await solveHumanChallengeIfPresent(page, { timeoutMs: 300_000 });

    const emailField = await waitForFirstVisible(page, emailSelectors, { timeoutMs: 300_000 });
    if (!emailField) {
      throw new Error(
        'Timed out waiting for the email/username field. The CAPTCHA may not have been solved, or the page layout changed. Try `npm run login -- --manual`.',
      );
    }

    process.stdout.write(`Entering username ${credentials.user} ...\n`);
    await page.locator(emailField).first().fill(credentials.user);

    const continueButton = await firstVisible(page, [
      'button:has-text("Continue")',
      'button#continue-button',
      'button[name="continue-button"]',
      'button[type="submit"]',
      'input[type="submit"][value*="Continue" i]',
    ]);
    if (!continueButton) {
      throw new Error('Could not find the "Continue" button on the username step. Try `npm run login -- --manual`.');
    }
    await page.locator(continueButton).first().click();

    process.stdout.write('Waiting for the password step ...\n');
    const passwordField = await waitForFirstVisible(page, passwordSelectors, { timeoutMs: 60_000 });
    if (!passwordField) {
      const errorText = await page
        .locator('.error, .errorMessage, [role="alert"], .field-validation-error, .error-msg')
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => null);
      throw new Error(
        `Password field never appeared after submitting the username.${
          errorText ? ` Site message: "${errorText.trim()}"` : ''
        } The username may be unrecognized, or another CAPTCHA was shown. Try \`npm run login -- --manual\`.`,
      );
    }

    process.stdout.write('Entering password ...\n');
    await page.locator(passwordField).first().fill(credentials.password);

    const submitButton = await firstVisible(page, [
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'button#signin-button',
      'button#btnLogin',
      'button#submit-button',
      'button[name="submit-button"]',
      'input#btnLogin',
      'button[type="submit"]',
      'input[type="submit"]',
    ]);
    if (!submitButton) {
      throw new Error('Could not find the sign-in submit button. Try `npm run login -- --manual`.');
    }

    await Promise.all([
      page
        .waitForURL((url) => !/signin\.aspx|accounts\.dowjones\.com/i.test(url.toString()), {
          timeout: 60_000,
        })
        .catch(() => {}),
      page.locator(submitButton).first().click(),
    ]);

    const url = page.url();
    if (/signin\.aspx|accounts\.dowjones\.com/i.test(url)) {
      const errorText = await page
        .locator('.error, .errorMessage, [role="alert"], .field-validation-error, .error-msg')
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => null);
      throw new Error(
        `Still on the sign-in page after submitting (${url}).${
          errorText ? ` Site message: "${errorText.trim()}"` : ''
        } Check IBD_USER / IBD_PASSWORD, or run \`npm run login -- --manual\`.`,
      );
    }

    process.stdout.write(`Signed in. Visiting ${IBD_BASE_URL} to warm the screener session ...\n`);
    await page.goto(IBD_BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await solveHumanChallengeIfPresent(page);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    process.stdout.write(
      `Profile saved at ${path.relative(process.cwd(), profileDir(paths))}\n`,
    );
  } finally {
    await context.close();
  }
}

async function firstVisible(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return selector;
    }
  }
  return null;
}

/**
 * Poll until any of the given selectors is visible, or the timeout elapses.
 * Used to wait for the sign-in form to appear after the user clears any
 * Dow Jones / IBD CAPTCHA interstitial.
 */
async function waitForFirstVisible(
  page: Page,
  selectors: string[],
  options: { timeoutMs: number; pollMs?: number },
): Promise<string | null> {
  const pollMs = options.pollMs ?? 1_000;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const found = await firstVisible(page, selectors);
    if (found) return found;
    await page.waitForTimeout(pollMs);
  }
  return null;
}

/**
 * Reopen the persistent profile created by loginInteractive(). The site sees the
 * same browser/profile as the manual login.
 */
export async function openAuthenticatedContext(
  paths: AppPaths,
  options: { headless?: boolean } = {},
): Promise<{ context: BrowserContext }> {
  if (!(await fileExists(profileDir(paths)))) {
    throw new Error(
      `No saved browser profile at ${profileDir(paths)}. Run \`npm run login\` first.`,
    );
  }
  const context = await launchPersistent(paths, { headless: options.headless ?? false });
  return { context };
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const onData = (): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
