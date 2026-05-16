import type { Frame, Page } from 'playwright';

/**
 * PerimeterX / HUMAN Security challenge handler.
 *
 * IBD's CDN occasionally interrupts requests with a "Please verify you are
 * a human" page containing a PRESS & HOLD button (PerimeterX's standard
 * proof-of-work). It appears both at login and randomly during scraping.
 *
 * Strategy:
 *   1. Detect the challenge by its text or the well-known `#px-captcha`
 *      container (it can be inline on the page or inside an iframe).
 *   2. Try one auto-solve attempt: synthesize a multi-second mouse hold on
 *      the button with light jitter. Sometimes this slips past, often not.
 *   3. Fall back to a "wait until the user solves it" loop -- because the
 *      project always runs headed, the user can simply press & hold in the
 *      Chromium window and the page will continue on its own.
 *
 * We never throw on a challenge: the caller can decide whether the page
 * eventually loaded by checking its own success criteria after we return.
 */

/** Text/selectors that identify the PerimeterX challenge page. */
const CHALLENGE_INDICATORS = [
  '#px-captcha',
  'text=Please verify you are a human',
  'text=Access to this page has been denied',
  'text=PRESS & HOLD',
  'text=Press & Hold',
] as const;

/** Selectors for the press-and-hold button itself (page or iframe). */
const PRESS_HOLD_BUTTON_SELECTORS = [
  '#px-captcha button',
  '#px-captcha [role="button"]',
  'button:has-text("PRESS & HOLD")',
  'button:has-text("Press & Hold")',
  '[role="button"]:has-text("PRESS & HOLD")',
  '[role="button"]:has-text("Press & Hold")',
] as const;

export type HumanCheckOptions = {
  /** How long to wait, in total, for the challenge to clear. Default 3 min. */
  timeoutMs?: number;
  /** If true, skip the auto-solve attempt and go straight to manual wait. */
  manualOnly?: boolean;
};

/**
 * Check the page (and its frames) for the PerimeterX challenge, and try to
 * clear it. Returns true if no challenge was present OR it was cleared,
 * false if it remained at the timeout.
 */
export async function solveHumanChallengeIfPresent(
  page: Page,
  options: HumanCheckOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 180_000;

  if (!(await isChallengePresent(page))) return true;

  process.stderr.write(
    '\nDetected IBD "Please verify you are a human" challenge.\n',
  );

  if (!options.manualOnly) {
    const autoSolved = await tryAutoPressAndHold(page);
    if (autoSolved) {
      process.stdout.write('Challenge cleared automatically.\n');
      return true;
    }
    process.stderr.write(
      'Auto press-and-hold did not clear the challenge.\n',
    );
  }

  process.stderr.write(
    [
      '',
      'Please switch to the Chromium window and press & hold the button',
      'for ~6 seconds. The scan will continue automatically once the',
      'page loads.',
      '',
    ].join('\n'),
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isChallengePresent(page))) {
      process.stdout.write('Challenge cleared. Continuing ...\n');
      return true;
    }
    await page.waitForTimeout(1_000);
  }
  process.stderr.write(
    `Timed out (${Math.round(timeoutMs / 1000)} s) waiting for human verification.\n`,
  );
  return false;
}

async function isChallengePresent(page: Page): Promise<boolean> {
  for (const root of [page as Page | Frame, ...page.frames()]) {
    for (const sel of CHALLENGE_INDICATORS) {
      const visible = await root
        .locator(sel)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return true;
    }
  }
  return false;
}

/**
 * Find the press-and-hold button in the page or any iframe and synthesize
 * a long mouse-down with jitter. PerimeterX is sophisticated enough that
 * this often fails, but the attempt is cheap and sometimes works on cold
 * profiles. We return immediately if no button is found.
 */
async function tryAutoPressAndHold(page: Page): Promise<boolean> {
  const found = await findPressHoldButton(page);
  if (!found) return false;

  try {
    const box = await found.locator.boundingBox();
    if (!box) return false;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // 8-12 s hold with small mouse jitter to look less like a synthetic click.
    await page.mouse.move(cx, cy, { steps: 12 });
    await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
    await page.mouse.down();
    const holdMs = 8_000 + Math.floor(Math.random() * 4_000);
    const start = Date.now();
    while (Date.now() - start < holdMs) {
      const jx = cx + (Math.random() - 0.5) * 2;
      const jy = cy + (Math.random() - 0.5) * 2;
      await page.mouse.move(jx, jy, { steps: 1 });
      await page.waitForTimeout(100);
    }
    await page.mouse.up();
  } catch {
    return false;
  }

  // Give the page ~5 s to navigate / clear the challenge.
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    if (!(await isChallengePresent(page))) return true;
  }
  return false;
}

async function findPressHoldButton(
  page: Page,
): Promise<{ root: Page | Frame; locator: ReturnType<Page['locator']> } | null> {
  for (const root of [page as Page | Frame, ...page.frames()]) {
    for (const sel of PRESS_HOLD_BUTTON_SELECTORS) {
      const loc = root.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) return { root, locator: loc };
    }
  }
  return null;
}
