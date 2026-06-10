# YouTube DOM Canary

This is an isolated Playwright tool for verifying the live YouTube transcript DOM selector used by the extension.

The extension currently extracts transcript text with:

```js
ytd-transcript-segment-renderer .segment-text
```

This tool opens a real YouTube watch page, opens the transcript panel through the page UI, and checks that selector with the same retry timing as `content.js`: 10 attempts spaced 500ms apart.

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

## Exit Codes

- `0`: selector works and returned transcript segments.
- `1`: transcript panel opened, but the selector returned no segments.
- `2`: the script could not open or detect the transcript panel.
- `3`: navigation, consent, bot check, or browser-level failure.

Exit code `1` is the actionable selector-change case. Exit code `2` means the panel button or YouTube user flow changed, or the chosen video does not expose a transcript. Exit code `3` is usually environmental or flaky and should be retried before drawing conclusions.
