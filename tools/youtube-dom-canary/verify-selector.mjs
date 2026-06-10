import { chromium } from 'playwright';

const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc';
const TRANSCRIPT_SELECTOR = 'ytd-transcript-segment-renderer .segment-text';
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 500;

const EXIT_SELECTOR_BROKEN = 1;
const EXIT_PANEL_NOT_OPENED = 2;
const EXIT_BROWSER_FAILURE = 3;

const videoUrl = normalizeWatchUrl(process.argv[2] || process.env.VIDEO_URL || DEFAULT_VIDEO_URL);
const headless = process.env.HEADLESS !== 'false';

main().catch(error => {
  console.error('[browser-failure]', error?.message || error);
  process.exit(EXIT_BROWSER_FAILURE);
});

async function main() {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1365, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });

  await seedConsentCookie(context);

  const page = await context.newPage();

  try {
    console.log(`[open] ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    await dismissConsentDialog(page);

    const blocked = await looksBlocked(page);
    if (blocked) {
      console.error('[browser-failure] YouTube showed a bot check, consent wall, or unavailable page.');
      process.exitCode = EXIT_BROWSER_FAILURE;
      return;
    }

    const opened = await openTranscriptPanel(page);
    if (!opened) {
      console.error('[panel-not-opened] Could not find or click a visible "Show transcript" control.');
      await printVisibleButtonHints(page);
      process.exitCode = EXIT_PANEL_NOT_OPENED;
      return;
    }

    const panelVisible = await waitForTranscriptPanel(page);
    if (!panelVisible) {
      console.error('[panel-not-opened] Clicked a transcript control, but no transcript panel was detected.');
      await printTranscriptDomHints(page);
      process.exitCode = EXIT_PANEL_NOT_OPENED;
      return;
    }

    const result = await queryTranscriptSegments(page);
    if (result.count > 0) {
      console.log(`[ok] selector "${TRANSCRIPT_SELECTOR}" returned ${result.count} segments.`);
      console.log(`[sample] ${result.sample.join(' | ')}`);
      process.exitCode = 0;
      return;
    }

    console.error(`[selector-broken] Transcript panel opened, but "${TRANSCRIPT_SELECTOR}" returned 0 segments.`);
    await printTranscriptDomHints(page);
    process.exitCode = EXIT_SELECTOR_BROKEN;
  } finally {
    await browser.close();
  }
}

function normalizeWatchUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('hl', 'en');
  return url.toString();
}

async function seedConsentCookie(context) {
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  await context.addCookies([
    {
      name: 'SOCS',
      value: 'CAI',
      domain: '.youtube.com',
      path: '/',
      expires,
      sameSite: 'Lax',
      secure: true,
    },
  ]);
}

async function dismissConsentDialog(page) {
  const candidates = [
    /accept all/i,
    /reject all/i,
    /i agree/i,
    /agree/i,
    /accept/i,
  ];

  for (const name of candidates) {
    const button = page.getByRole('button', { name }).first();
    if (await isVisible(button)) {
      await button.click({ timeout: 3_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      return;
    }
  }
}

async function looksBlocked(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  return /sign in to confirm|unusual traffic|not a bot|captcha|video unavailable/i.test(bodyText);
}

async function openTranscriptPanel(page) {
  await page.locator('ytd-watch-flexy').waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});

  if (await clickShowTranscript(page)) {
    return true;
  }

  await expandDescription(page);

  if (await clickShowTranscript(page)) {
    return true;
  }

  await openMoreActionsMenu(page);

  return clickShowTranscript(page);
}

async function expandDescription(page) {
  const selectors = [
    'tp-yt-paper-button#expand',
    'ytd-text-inline-expander tp-yt-paper-button#expand',
    '#description-inline-expander button',
  ];

  for (const selector of selectors) {
    const control = page.locator(selector).first();
    if (await isVisible(control)) {
      await control.click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }

  const moreButton = page.getByRole('button', { name: /^more$/i }).first();
  if (await isVisible(moreButton)) {
    await moreButton.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function openMoreActionsMenu(page) {
  const moreActions = page.locator('ytd-menu-renderer button[aria-label*="More actions"]').first();
  if (await isVisible(moreActions)) {
    await moreActions.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function clickShowTranscript(page) {
  const directButton = page.getByRole('button', { name: /show transcript/i }).first();
  if (await isVisible(directButton)) {
    await directButton.click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
    return true;
  }

  const textControl = page.getByText(/show transcript/i).first();
  if (await isVisible(textControl)) {
    await textControl.click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
    return true;
  }

  return false;
}

async function waitForTranscriptPanel(page) {
  const panelSelector = [
    'ytd-transcript-renderer',
    'ytd-transcript-search-panel-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
  ].join(', ');

  await page.locator(panelSelector).first().waitFor({ state: 'attached', timeout: 8_000 }).catch(() => {});

  return page.locator(panelSelector).count().then(count => count > 0);
}

async function queryTranscriptSegments(page) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await page.evaluate(selector => {
      const segments = [...document.querySelectorAll(selector)];
      return {
        count: segments.length,
        sample: segments.slice(0, 3).map(segment => segment.textContent.trim()).filter(Boolean),
      };
    }, TRANSCRIPT_SELECTOR);

    if (result.count > 0 || attempt === MAX_RETRIES) {
      return result;
    }

    await page.waitForTimeout(RETRY_DELAY_MS);
  }

  return { count: 0, sample: [] };
}

async function printVisibleButtonHints(page) {
  const buttons = await page.evaluate(() => {
    return [...document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape')]
      .map(element => ({
        text: element.textContent.replace(/\s+/g, ' ').trim(),
        aria: element.getAttribute('aria-label') || '',
      }))
      .filter(({ text, aria }) => text || aria)
      .slice(0, 40);
  });

  console.error('[button-hints]');
  for (const button of buttons) {
    console.error(`- text="${button.text}" aria="${button.aria}"`);
  }
}

async function printTranscriptDomHints(page) {
  const hints = await page.evaluate(() => {
    const panel =
      document.querySelector('ytd-transcript-renderer') ||
      document.querySelector('ytd-transcript-search-panel-renderer') ||
      document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]') ||
      document.body;

    const customTags = [...new Set([...panel.querySelectorAll('*')]
      .map(element => element.localName)
      .filter(name => name?.includes('-'))
      .filter(name => /transcript|segment|cue|caption|line/.test(name)))]
      .sort();

    const classes = [...new Set([...panel.querySelectorAll('[class]')]
      .flatMap(element => [...element.classList])
      .filter(className => /transcript|segment|cue|caption|line|text/.test(className)))]
      .sort();

    return { customTags, classes };
  });

  console.error('[transcript-dom-hints]');
  console.error(`customTags=${JSON.stringify(hints.customTags)}`);
  console.error(`classes=${JSON.stringify(hints.classes)}`);
}

async function isVisible(locator) {
  return locator.isVisible({ timeout: 1_000 }).catch(() => false);
}
