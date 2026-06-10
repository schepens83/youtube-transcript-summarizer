# YouTube DOM Canary

This is an isolated Playwright tool for verifying the live YouTube transcript DOM selector used by the extension.

The extension currently extracts transcript text in `../../content.js` with:

```js
document.querySelectorAll('ytd-transcript-segment-renderer .segment-text')
```

This tool reads the selector from `content.js`, opens a real YouTube watch page, opens the transcript panel through the page UI, and checks that selector with the same retry timing as `content.js`: 10 attempts spaced 500ms apart.

## Setup

Run these commands from this directory:

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
npm run verify
```

To verify a specific video:

```bash
npm run verify -- "https://www.youtube.com/watch?v=Ks-_Mh1QhMc"
```

For visible browser debugging:

```bash
HEADLESS=false npm run verify
```

The script prints the video title, selector, segment count, and a short sample when verification succeeds.

## Exit Codes

- `0`: selector works and returned transcript segments.
- `1`: transcript panel opened, but the selector returned no segments.
- `2`: the script could not open or detect the transcript panel.
- `3`: navigation, consent, bot check, or browser-level failure.

Exit code `1` is the actionable selector-change case. Exit code `2` means the panel button or YouTube user flow changed, or the chosen video does not expose a transcript. Exit code `3` is usually environmental or flaky and should be retried before drawing conclusions.

## Scheduled Sandbox Routine

Run this from a locked-down environment that has:

- outbound HTTPS access to YouTube;
- no OpenRouter API key or Chrome extension credentials;
- a non-root user;
- a writable working directory only for this tool's `node_modules`, browser cache, and logs.

Suggested first-time setup:

```bash
cd /path/to/youtube-transcript-summarizer/tools/youtube-dom-canary
npm install --no-package-lock
npx playwright install chromium
```

Run the environment preflight after setup:

```bash
npm run doctor
```

`doctor` checks that the selector can be read from `content.js`, Chromium can launch, and the sandbox can reach YouTube over HTTPS.

Suggested scheduled command:

```bash
cd /path/to/youtube-transcript-summarizer/tools/youtube-dom-canary
npm run verify
```

For cron, capture output and alert only on non-zero exit:

```cron
17 8 * * 1 cd /path/to/youtube-transcript-summarizer/tools/youtube-dom-canary && npm run verify >> verify-selector.log 2>&1
```

Do not run the whole extension in the scheduled sandbox. This canary only needs public YouTube DOM access and does not need the OpenRouter API path, extension storage, modal code, background worker, or manifest.

This tool intentionally ignores `package-lock.json` so sandbox setup does not create repo churn. If this tool ever needs pinned dependency reproducibility, remove that ignore rule and commit the lockfile deliberately.

## Maintenance Routine

When the scheduled canary reports:

- `0`: make no repo changes. Report the live video title and segment count from the output.
- `1`: YouTube likely renamed transcript DOM elements or classes. Inspect the printed `transcript-dom-hints`, update only the DOM-extraction selector logic inside `fetchTranscript()` in `../../content.js`, rerun this canary, then commit and push to `main`.
- `2`: the transcript panel button, transcript location, or chosen video may have changed. Report that as a panel-opening failure. Do not add automatic panel-opening behavior to the extension without explicit approval.
- `3`: read the bracketed category, fix the environment or retry, and do not change extension code.

Exit code `3` categories include:

- `browser-deps-missing`: Chromium could not launch because shared libraries are missing. Run `sudo npx playwright install-deps chromium` in the sandbox image or install the equivalent distro packages.
- `browser-launch-failed`: Chromium failed before navigation for a non-dependency reason. Check sandbox permissions, executable paths, and Playwright browser installation.
- `network-failed`: the sandbox could not reach YouTube over HTTPS. Check egress, DNS, proxy, and firewall policy.
- `navigation-timeout`: YouTube did not finish initial page navigation within the timeout. Retry before changing code.
- `consent-wall`: YouTube showed a consent screen that the canary could not dismiss.
- `youtube-blocked`: YouTube showed a bot check, unusual-traffic page, or sign-in gate.
- `youtube-video-unavailable`: the configured video is unavailable. Use a different transcript-bearing video URL.

If a selector fix is needed, keep `fetchTranscript()` returning one plain-text transcript string and keep the existing retry behavior unless the live DOM change requires otherwise. Do not modify the OpenRouter call, prompt text, modal, manifest, options page, or background worker as part of selector maintenance.
