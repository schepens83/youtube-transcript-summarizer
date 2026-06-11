import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import path from 'node:path';

const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc';
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 500;
const CONTENT_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../content.js',
);

const EXIT_SELECTOR_BROKEN = 1;
const EXIT_PANEL_NOT_OPENED = 2;
const EXIT_BROWSER_FAILURE = 3;

const args = process.argv.slice(2);
const doctorMode = args.includes('--doctor');
const requestedVideoUrl = args.find(arg => !arg.startsWith('--'));
const videoUrl = normalizeWatchUrl(requestedVideoUrl || process.env.VIDEO_URL || DEFAULT_VIDEO_URL);
const headless = process.env.HEADLESS !== 'false';

main().catch(error => {
  reportBrowserFailure(error?.category || categorizeFailure(error), error?.message || String(error));
  process.exit(EXIT_BROWSER_FAILURE);
});

async function main() {
  const transcriptSelector = await readTranscriptSelector();
  if (doctorMode) {
    await runDoctor(transcriptSelector);
    return;
  }

  const browser = await launchBrowser();
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
    console.log(`[selector] ${transcriptSelector}`);
    await navigateToVideo(page);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    await dismissConsentDialog(page);

    const blockReason = await blockedPageReason(page);
    if (blockReason) {
      reportBrowserFailure(blockReason, youtubeBlockMessage(blockReason));
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

    const postOpenBlockReason = await blockedPageReason(page);
    if (postOpenBlockReason) {
      reportBrowserFailure(postOpenBlockReason, youtubeBlockMessage(postOpenBlockReason));
      process.exitCode = EXIT_BROWSER_FAILURE;
      return;
    }

    const panelVisible = await waitForTranscriptPanel(page);
    if (!panelVisible) {
      console.error('[panel-not-opened] Clicked a transcript control, but no transcript panel was detected.');
      await printTranscriptDomHints(page);
      process.exitCode = EXIT_PANEL_NOT_OPENED;
      return;
    }

    const result = await queryTranscriptSegments(page, transcriptSelector);
    if (result.count > 0) {
      console.log(`[video] ${await videoTitle(page)}`);
      console.log(`[ok] selector "${transcriptSelector}" returned ${result.count} segments.`);
      console.log(`[sample] ${result.sample.join(' | ')}`);
      process.exitCode = 0;
      return;
    }

    const postQueryBlockReason = await blockedPageReason(page);
    if (postQueryBlockReason) {
      reportBrowserFailure(postQueryBlockReason, youtubeBlockMessage(postQueryBlockReason));
      process.exitCode = EXIT_BROWSER_FAILURE;
      return;
    }

    console.error(`[selector-broken] Transcript panel opened, but "${transcriptSelector}" returned 0 segments.`);
    await printTranscriptDomHints(page);
    process.exitCode = EXIT_SELECTOR_BROKEN;
  } finally {
    await browser.close();
  }
}

async function runDoctor(transcriptSelector) {
  console.log(`[selector] ${transcriptSelector}`);
  console.log('[doctor] checking Chromium launch');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto('about:blank');
  await browser.close();
  console.log('[doctor] Chromium launch ok');

  console.log('[doctor] checking outbound HTTPS to YouTube');
  await checkYoutubeHttps();
  console.log('[doctor] YouTube HTTPS ok');
  console.log('[doctor] sandbox can run the canary');
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    reportBrowserFailure(categorizeFailure(error), error?.message || String(error));
    process.exit(EXIT_BROWSER_FAILURE);
  }
}

async function navigateToVideo(page) {
  try {
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    reportBrowserFailure(categorizeNavigationFailure(error), error?.message || String(error));
    process.exit(EXIT_BROWSER_FAILURE);
  }
}

async function readTranscriptSelector() {
  const source = await readFile(CONTENT_SCRIPT_PATH, 'utf8');
  const querySelectorAllCalls = [...source.matchAll(/querySelectorAll\((['"`])([^'"`]+)\1\)/g)];

  if (querySelectorAllCalls.length !== 1) {
    throw new Error(
      `Expected exactly one querySelectorAll(...) call in ${CONTENT_SCRIPT_PATH}, found ${querySelectorAllCalls.length}.`,
    );
  }

  return querySelectorAllCalls[0][2];
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

async function blockedPageReason(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  if (/before you continue to youtube|accept all|reject all|manage options/i.test(bodyText)) {
    return 'consent-wall';
  }
  if (/sign in to confirm|unusual traffic|not a bot|captcha/i.test(bodyText)) {
    return 'youtube-blocked';
  }
  if (/video unavailable/i.test(bodyText)) {
    return 'youtube-video-unavailable';
  }
  return null;
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

async function queryTranscriptSegments(page, selector) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await page.evaluate(selector => {
      const segments = [...document.querySelectorAll(selector)];
      return {
        count: segments.length,
        sample: segments.slice(0, 3).map(segment => segment.textContent.trim()).filter(Boolean),
      };
    }, selector);

    if (result.count > 0 || attempt === MAX_RETRIES) {
      return result;
    }

    await page.waitForTimeout(RETRY_DELAY_MS);
  }

  return { count: 0, sample: [] };
}

async function videoTitle(page) {
  return page.locator('h1 yt-formatted-string, h1.title').first()
    .innerText({ timeout: 3_000 })
    .catch(() => page.title());
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

function checkYoutubeHttps() {
  return new Promise((resolve, reject) => {
    const request = https.get('https://www.youtube.com/generate_204', { timeout: 10_000 }, response => {
      response.resume();
      response.on('end', resolve);
    });

    request.on('timeout', () => {
      request.destroy(new Error('Timed out reaching https://www.youtube.com/generate_204'));
    });

    request.on('error', error => {
      error.category = 'network-failed';
      reject(error);
    });
  });
}

function categorizeFailure(error) {
  const message = error?.message || String(error);
  if (/missing dependencies|install-deps|lib[^/\s]+\.so|error while loading shared libraries/i.test(message)) {
    return 'browser-deps-missing';
  }
  return 'browser-launch-failed';
}

function categorizeNavigationFailure(error) {
  const message = error?.message || String(error);
  if (/timeout/i.test(message)) {
    return 'navigation-timeout';
  }
  if (/net::|ERR_|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    return 'network-failed';
  }
  return 'navigation-failed';
}

function youtubeBlockMessage(category) {
  if (category === 'consent-wall') {
    return 'YouTube showed a consent wall that the canary could not dismiss.';
  }
  if (category === 'youtube-video-unavailable') {
    return 'YouTube reported that the selected video is unavailable.';
  }
  return 'YouTube showed a bot check, unusual-traffic page, or sign-in gate.';
}

function reportBrowserFailure(category, message) {
  console.error(`[${category}] ${message}`);

  if (category === 'browser-deps-missing') {
    console.error('Install Playwright browser dependencies with:');
    console.error('  sudo npx playwright install-deps chromium');
  }

  if (category === 'network-failed') {
    console.error('Verify that the sandbox allows outbound HTTPS to youtube.com.');
  }

  console.error('No selector conclusion was reached.');
}
