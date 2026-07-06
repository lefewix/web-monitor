# Web Monitor

A browser extension that watches web pages for changes — a self-hosted alternative to Distill. Add a URL, and every 30 seconds the extension re-fetches the page and alerts you when it changes. Built for restock watching: give it a phrase like "sold out" and it alerts only when that phrase appears or disappears.

## Features

- **30-second checks** — each watched page is re-fetched on a `chrome.alarms` schedule; no tab needs to stay open
- **Phrase watching** — optionally watch a specific phrase (e.g. `sold out`); alerts fire only when it appears or disappears, ignoring all other page churn
- **Full-page mode** — without a phrase, any change to the page's visible text triggers an alert
- **Desktop notifications** — Windows/macOS toast per alert; clicking it opens the page
- **Webhook pings** — optionally POST every alert to a webhook (ntfy.sh, Discord, IFTTT → email)
- **Alert history** — the last 50 alerts are kept in the popup
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
4. Press **Watch**
5. Hover a watch's status text to confirm the phrase was found (`currently present`)

When a change is detected you get a desktop notification, an orange badge on the toolbar icon, an entry in the popup's alert history, and a webhook ping if configured.

### Discord alerts

1. Server Settings → Integrations → Webhooks → **New Webhook** → copy the URL
2. Paste it under **Settings** in the popup and press **Save**

## How it works

Each check fetches the page's raw HTML, strips `<script>`/`<style>` blocks and all tags, and collapses whitespace, leaving only the visible text. In phrase mode, the alert fires when the phrase's presence in that text flips. In full-page mode, the text is SHA-256 hashed and compared against the previous check's hash.

## Limitations

- Checks only run while the browser is running (see the background-apps setting above)
- Pages that render their content with JavaScript can't be seen — the extension fetches raw HTML only. If the phrase tooltip says `absent` while you can see it on the page, the site renders client-side
- Full-page mode can false-alarm on pages with rotating content (ads, view counters); use phrase mode for those
- 30 seconds is `chrome.alarms`' minimum interval

## License

[MIT](LICENSE) © Felix Wang
