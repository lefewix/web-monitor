# Web Monitor

A browser extension that watches web pages for changes — a self-hosted alternative to Distill. Add a URL, pick how often to check, and the extension re-fetches the page and alerts you when it changes. Built for restock watching: give it a phrase like "sold out" and it alerts only when that phrase appears or disappears.

## Features

- **Per-watch intervals** — 30s, 1m, 5m, 15m, or 1h per page, on a `chrome.alarms` schedule; no tab needs to stay open
- **CSS-selector watching** — narrow a watch to one element (`#price`, `.stock`, `div.price`) so the rest of the page can churn freely
- **Phrase watching** — optionally watch a specific phrase (e.g. `sold out`); alerts fire only when it appears or disappears, ignoring all other page churn
- **Full-page mode** — without a phrase, any change to the page's visible text triggers an alert
- **Desktop notifications** — Windows/macOS toast per alert; clicking it opens the page
- **Webhook pings** — optionally POST every alert to a webhook (ntfy.sh, Discord, IFTTT → email)
- **Snooze** — mute a noisy watch for 1h/6h/24h; it keeps checking and tracking state, it just stops notifying
- **Webhook testing** — a **Test** button reports the real outcome (`204 No Content`, `404 — webhook deleted?`, `timed out`), and the last real delivery failure stays visible
- **Alert history** — the last 50 alerts are kept in the popup, each with a preview of what actually changed
- **Privacy-first** — watches, hashes, and history live in `chrome.storage.local`; the only network calls are to the pages you watch and the webhook you configure

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
5. Pick a check interval (default 30s) and press **Watch**
6. Hover a watch's chips to confirm the phrase was found (`currently present`)

When a change is detected you get a desktop notification, a violet badge on the toolbar icon, an entry in the popup's alert history, and a webhook ping if configured.

### Discord alerts

1. Server Settings → Integrations → Webhooks → **New Webhook** → copy the URL
2. Paste it under **Settings** in the popup and press **Save**

## How it works

Each check fetches the page's raw HTML (20s timeout). A non-2xx response is recorded as a check error and never hashed or alerted on. If a selector is set, a small hand-written tag scanner pulls out that element first — `DOMParser` doesn't exist in a service worker, so selector support is limited to `#id`, `.class`, `tag`, and combinations like `div.price`; no descendant combinators. The remaining HTML then has its `<script>`/`<style>` blocks and all tags stripped and its whitespace collapsed, leaving only the visible text. In phrase mode, the alert fires when the phrase's presence in that text flips. In full-page mode, the text is SHA-256 hashed and compared against the previous check's hash.

## Limitations

- Checks only run while the browser is running (see the background-apps setting above)
- Pages that render their content with JavaScript can't be seen — the extension fetches raw HTML only. If the phrase tooltip says `absent` while you can see it on the page, the site renders client-side
- Full-page mode can false-alarm on pages with rotating content (ads, view counters); use phrase mode for those
- 30 seconds is `chrome.alarms`' minimum interval, and sub-minute alarms need Chrome 120+ (the manifest declares this)
- Selectors match the first element only, and don't support descendant/child combinators

## License

[MIT](LICENSE) © Felix Wang
