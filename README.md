# Web Monitor

A browser extension that watches web pages for changes — a self-hosted alternative to Distill. Add a URL, pick how often to check, and the extension re-fetches the page and alerts you when it changes. Built for restock watching: give it a phrase like "sold out" and it alerts only when that phrase appears or disappears.

## Features

- **Per-watch intervals** — 30s, 1m, 5m, 15m, or 1h per page, on a `chrome.alarms` schedule; no tab needs to stay open. The default is **5m**: 30s polling of an arbitrary site is 2,880 requests a day per watch, which invites the very bot walls the checker defends against
- **CSS-selector watching** — narrow a watch to one element (`#price`, `.stock`, `div.price.big`) so the rest of the page can churn freely
- **Phrase watching** — optionally watch a specific phrase (e.g. `sold out`); alerts fire only when it appears or disappears, ignoring all other page churn
- **Full-page mode** — without a phrase, any change to the page's visible text triggers an alert
- **Desktop notifications** — Windows/macOS toast per alert; clicking it opens the page
- **Webhook pings** — optionally POST every alert to a webhook (ntfy.sh, Discord, IFTTT → email)
- **Snooze** — mute any watch for 1h/6h/24h, before or after it gets noisy; it keeps checking and tracking state, it just stops notifying. A mute delays alerts, it never eats them: a change (or a death) that happens while muted is queued and delivered once you unmute or the snooze expires
- **Dead-watch alerts** — three consecutive failed checks raise their own notification and webhook ping ("Watch stopped working — HTTP 403"), so a watch that quietly broke can't look healthy
- **Bot-wall detection** — a 200 response that is empty, non-HTML, redirected elsewhere, an interstitial, or suddenly 70% smaller is recorded as a check error instead of being alerted on as a change
- **Alert throttle** — one alert per watch per 5 minutes; further changes are counted (`+12 more`) rather than spamming you
- **Undo** — deleting a watch, clearing history, and clearing a row's changed mark are all undoable from a toast, not guarded by a confirm dialog
- **Webhook testing** — a **Test** button reports the real outcome (`204 No Content`, `404 — webhook deleted?`, `timed out`), and the last real delivery failure stays visible
- **Alert history** — the last 50 alerts are kept in the popup, each with a preview of what actually changed, capped at 10 per watch so one noisy page can't evict everything else
- **Built for volume** — changed and broken watches float to the top, and a filter box appears past five watches; every row has a **check** button
- **Privacy-first** — watches, hashes, and history live in `chrome.storage.local`; the only network calls are to the pages you watch and the webhook you configure
- **Minimal permissions** — `alarms`, `storage`, `notifications` and host access, nothing else. The `background` permission (which keeps Chrome alive after its last window closes) is deliberately *not* requested: it contradicts the popup's own "checks run while Chrome runs" line and widens the install warning. `tabs` isn't requested either — the current tab's URL is readable for the pre-fill via the host permission alone

## Installation

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome, Brave, or Edge
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this project folder
5. (Optional) In Chrome settings, enable **System → Continue running background apps when Google Chrome is closed** so checks keep running with all windows closed

## Usage

1. Browse to the page you want to watch (the popup pre-fills the current tab's URL)
2. Click the Web Monitor icon
3. Optionally enter a phrase to watch, e.g. `sold out`
4. Optionally enter a CSS selector to watch just one element, e.g. `#price`
5. Pick a check interval (default 5m; 30s is still available for the pages that need it) and press **Watch**
6. Each row shows whether the phrase is `present`, `absent`, or `not checked yet`

When a change is detected you get a desktop notification, a violet badge on the toolbar icon, an entry in the popup's alert history, and a webhook ping if configured.

### Discord alerts

1. Server Settings → Integrations → Webhooks → **New Webhook** → copy the URL
2. Paste it under **Settings** in the popup and press **Save**

## How it works

Each check fetches the page's raw HTML (20s timeout). A non-2xx response is recorded as a check error and never hashed or alerted on — and neither is a 200 that fails any of the cheap sanity gates: a final URL on a different path (login walls, challenge redirects), a non-HTML content-type, a body under 100 characters, a known interstitial ("Just a moment…", "Checking your browser"), or extracted text that collapsed to under 30% of the last good snapshot. Twenty watches at 30s is 40 requests a minute from one IP, which is enough to get you an interstitial; without those gates every watch would cry restock at once.

Markup that a browser never renders — `<script>`, `<style>`, `<template>` and `<noscript>` bodies, plus comments, CDATA and doctypes — is stripped up front by a single left-to-right scan in the order a parser sees things, so a selector can't match a copy of your element that only exists inside a JS template string, a commented-out `<script>` tag can't delete the rest of the document, and a `>` inside a quoted attribute can't leak into the watched text. If a selector is set, a small hand-written tag scanner pulls out that element next — `DOMParser` doesn't exist in a service worker, so selector support is limited to `#id`, `.class`, `tag`, and combinations like `div.price.big`; no descendant combinators. The remaining tags are stripped, HTML entities decoded (`Sold&nbsp;out` → `Sold out`) and whitespace collapsed, leaving only the visible text. In phrase mode, the alert fires when the phrase's presence in that text flips. In full-page mode, the text is SHA-256 hashed and compared against the previous check's hash.

The service worker is the **single writer** for the watch list and alert history: every mutation runs through one module-level promise queue, and the popup only sends messages. Without that, a check landing at the same moment as a snooze click would read-modify-write the whole map and silently drop one of the two changes. Checks are de-duplicated per URL, delivery is serialised per URL, and an alert is committed as a `pendingAlert` that is only cleared once it has actually gone out — so a worker death between "mark it changed" and "tell the user" produces a retry, not a silent miss. The notification and the webhook are sent **independently**: with OS notifications blocked, the webhook still goes out, and vice versa. If neither lands after five attempts the watch keeps a sticky "alert not delivered" state that no later successful check can erase; you dismiss it yourself.

Run `node test.js` for the test suite (no dependencies, no build).

## Limitations

- Checks only run while the browser is running (see the background-apps setting above)
- Pages that render their content with JavaScript can't be seen — the extension fetches raw HTML only. If a row says `absent` while you can see the phrase on the page, the site renders client-side
- Full-page mode can false-alarm on pages with rotating content (ads, view counters); use phrase mode for those
- 30 seconds is `chrome.alarms`' minimum interval, and sub-minute alarms need Chrome 120+ (the manifest declares this)
- Pages are fetched **without your cookies**, so anything behind a login is seen logged out — watch a public URL, or expect the signed-out version of the page
- The response is decoded using the charset the server declares; a page in a legacy encoding that declares it only in a `<meta>` tag can come back with mangled characters, which a phrase watch will not match
- Selectors match the first element only, and don't support descendant/child combinators
- An element the scanner can't find an end for is reported as a selector error rather than silently widening the watch to the rest of the document
- Alerts are throttled to one per watch per 5 minutes; changes inside the window are counted, not sent
- Re-adding a URL edits the existing watch (its baseline and snooze survive); changing the phrase or selector re-baselines it, since the stored hash no longer means anything

## License

[MIT](LICENSE) © Felix Wang
