// Service worker: wakes on each alarm, fetches the page, compares hash, notifies.

const PAGE_TIMEOUT_MS = 20000;
const WEBHOOK_TIMEOUT_MS = 10000;
const MAX_TEXT_SNAPSHOT = 5000;
const MAX_PREVIEW = 200;

async function getWatches() {
  return (await chrome.storage.local.get("watches")).watches || {};
}

// Re-read the map, mutate ONLY this entry, write back. Returns the fresh map,
// or null if the watch vanished while we were awaiting something.
async function updateWatch(url, mutate) {
  const watches = await getWatches();
  const w = watches[url];
  if (!w) return null; // deleted mid-check — don't resurrect it
  mutate(w);
  await chrome.storage.local.set({ watches });
  return watches;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- html → text

// strip scripts/styles/tags/whitespace so markup churn doesn't false-alarm
function textFromHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<style[\s\S]*?<\/style>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .trim();
}

// ------------------------------------------------------- tiny selector engine
// DOMParser doesn't exist in a service worker, so this is a small hand-written
// tag scanner. Supported selectors: "#id", ".class", "tag", and combinations
// like "div.price" / "span#total". No descendant/child combinators.

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "param", "source", "track", "wbr"]);

function parseSelector(sel) {
  const s = (sel || "").trim();
  if (!s) return null;
  let tag = "", id = "", cls = "", mode = "tag";
  for (const ch of s) {
    if (ch === "#") { mode = "id"; continue; }
    if (ch === ".") { mode = "cls"; continue; }
    if (mode === "tag") tag += ch;
    else if (mode === "id") id += ch;
    else cls += ch;
  }
  if (!tag && !id && !cls) return null;
  return { tag: tag.toLowerCase(), id, cls };
}

// Reads the tag starting at html[i] === "<". Returns null if it isn't a tag.
function readTag(html, i) {
  if (html[i] !== "<") return null;
  let j = i + 1;
  const close = html[j] === "/";
  if (close) j++;
  if (!/[a-zA-Z]/.test(html[j] || "")) return null; // comment, doctype, stray "<"
  let name = "";
  while (j < html.length && /[a-zA-Z0-9:-]/.test(html[j])) name += html[j++];
  // consume attributes, respecting quotes so ">" inside a value doesn't fool us
  const attrStart = j;
  let quote = null;
  while (j < html.length) {
    const c = html[j];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") break;
    j++;
  }
  const raw = html.slice(attrStart, j);
  return {
    name: name.toLowerCase(),
    close,
    selfClose: raw.trimEnd().endsWith("/"),
    raw,
    end: j + 1, // index just past ">"
  };
}

function attrValue(raw, attr) {
  const lower = raw.toLowerCase();
  let from = 0;
  while (true) {
    const at = lower.indexOf(attr, from);
    if (at === -1) return "";
    const before = at === 0 ? " " : raw[at - 1];
    let k = at + attr.length;
    while (k < raw.length && /\s/.test(raw[k])) k++;
    if (!/[\s]/.test(before) || raw[k] !== "=") { from = at + attr.length; continue; }
    k++;
    while (k < raw.length && /\s/.test(raw[k])) k++;
    const q = raw[k];
    if (q === '"' || q === "'") {
      const end = raw.indexOf(q, k + 1);
      return end === -1 ? "" : raw.slice(k + 1, end);
    }
    let v = "";
    while (k < raw.length && !/\s/.test(raw[k])) v += raw[k++];
    return v;
  }
}

function tagMatches(tag, sel) {
  if (sel.tag && tag.name !== sel.tag) return false;
  if (sel.id && attrValue(tag.raw, "id") !== sel.id) return false;
  if (sel.cls && !attrValue(tag.raw, "class").split(/\s+/).includes(sel.cls)) return false;
  return true;
}

// Returns the inner HTML of the first element matching `selector`, or null.
function extractSelector(html, selector) {
  const sel = parseSelector(selector);
  if (!sel) return null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return null;
    const tag = readTag(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if (!tag.close && tagMatches(tag, sel)) {
      if (tag.selfClose || VOID_TAGS.has(tag.name)) return "";
      // walk forward to the matching close tag, counting nested same-name tags
      let depth = 1, k = tag.end;
      while (k < html.length) {
        const nlt = html.indexOf("<", k);
        if (nlt === -1) break;
        const t = readTag(html, nlt);
        if (!t) { k = nlt + 1; continue; }
        if (t.name === tag.name && !VOID_TAGS.has(t.name)) {
          if (t.close) {
            depth--;
            if (depth === 0) return html.slice(tag.end, nlt);
          } else if (!t.selfClose) depth++;
        }
        k = t.end;
      }
      return html.slice(tag.end); // unclosed — take the rest
    }
    i = tag.end;
  }
  return null;
}

// ------------------------------------------------------------------- previews

function clip(s) {
  return s.length > MAX_PREVIEW ? s.slice(0, MAX_PREVIEW - 1) + "…" : s;
}

function phrasePreview(text, keyword, present) {
  let ctx = "";
  const i = text.toLowerCase().indexOf(keyword);
  if (present && i !== -1) ctx = text.slice(Math.max(0, i - 60), i + 140).trim();
  return clip(`“${keyword}” ${present ? "appeared" : "disappeared"}` + (ctx ? ` — …${ctx}…` : ""));
}

// First region where the new text diverges from the stored snapshot.
function diffPreview(oldText, newText) {
  if (!oldText) return "";
  let i = 0;
  const n = Math.min(oldText.length, newText.length);
  while (i < n && oldText[i] === newText[i]) i++;
  const start = Math.max(0, i - 40);
  const slice = newText.slice(start, start + MAX_PREVIEW).trim();
  return clip((start ? "…" : "") + slice);
}

// -------------------------------------------------------------------- webhook

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return DISCORD_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.startsWith("/api/webhooks");
  } catch {
    return false;
  }
}

// Returns { ok, detail } — detail is human-readable and shown in the popup.
async function sendWebhook(webhook, msg) {
  try {
    const init = { method: "POST", signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) };
    if (isDiscordWebhook(webhook)) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify({ content: msg });
    } else {
      init.body = msg;
    }
    const res = await fetch(webhook, init);
    if (res.ok) return { ok: true, detail: `${res.status} ${res.statusText || "OK"}`.trim() };
    const hint = res.status === 404 ? " — webhook deleted?" : res.status === 401 || res.status === 403 ? " — not authorised" : "";
    return { ok: false, detail: `${res.status} ${res.statusText || ""}`.trim() + hint };
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, detail: timedOut ? "timed out" : `network error — ${e && e.message ? e.message : e}` };
  }
}

async function recordWebhookFailure(detail) {
  await chrome.storage.local.set({ webhookStatus: { ok: false, detail, ts: Date.now() } });
}

// ---------------------------------------------------------------------- check

async function check(url) {
  const w0 = (await getWatches())[url];
  if (!w0) return; // watch was removed; stale alarm

  const fail = async message => {
    await updateWatch(url, w => { w.lastError = message; w.lastCheck = Date.now(); });
  };

  let res;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (web-monitor)" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(timedOut ? "timed out" : (e && e.message) || String(e));
  }

  // non-2xx: an error page is not the page — never hash it, never alert on it
  if (!res.ok) return fail(`HTTP ${res.status}`);

  let body;
  try {
    body = await res.text();
  } catch (e) {
    return fail((e && e.message) || String(e));
  }

  if (w0.selector) {
    const inner = extractSelector(body, w0.selector);
    if (inner === null) return fail(`selector not found: ${w0.selector}`);
    body = inner;
  }

  const text = textFromHtml(body);
  const h = await sha256(text);

  let title = null, preview = "";
  if (w0.keyword) {
    // keyword mode: alert only when the keyword appears/disappears (e.g. "sold out" gone = restock)
    const present = text.toLowerCase().includes(w0.keyword);
    if (w0.keywordPresent !== undefined && present !== w0.keywordPresent) {
      title = `Product status changed — "${w0.keyword}" ${present ? "reappeared" : "gone"}`;
      preview = phrasePreview(text, w0.keyword, present);
    }
  } else if (w0.lastHash && w0.lastHash !== h) {
    title = "Page changed";
    preview = diffPreview(w0.lastText || "", text);
  }

  // Persist state BEFORE alerting: a slow/failing webhook must never cause the
  // same change to fire again on the next tick.
  const keywordPresent = w0.keyword ? text.toLowerCase().includes(w0.keyword) : undefined;
  const watches = await updateWatch(url, w => {
    if (w.keyword) w.keywordPresent = keywordPresent;
    w.lastHash = h;
    w.lastText = text.slice(0, MAX_TEXT_SNAPSHOT);
    w.lastError = null;
    w.lastCheck = Date.now();
    if (title) w.changed = true;
  });
  if (!watches) return; // deleted while we fetched — stay deleted

  if (title) {
    const snoozed = watches[url].snoozeUntil > Date.now();
    await fireAlert(url, title, preview, watches, snoozed);
  }
}

async function fireAlert(url, title, preview, watches, snoozed) {
  updateBadge(watches);

  // append to alert history, newest first, capped at 50 (re-read: it's shared)
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift({ ts: Date.now(), url, title, preview });
  await chrome.storage.local.set({ history: history.slice(0, 50) });

  if (snoozed) return; // still tracking, just not shouting about it

  chrome.notifications.create(url, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message: preview ? `${url}\n${preview}` : url,
  });

  // optional webhook ping (ntfy.sh, discord, ifttt → email, anything that takes a POST)
  const { webhook } = await chrome.storage.local.get("webhook");
  if (webhook) {
    const r = await sendWebhook(webhook, `${title}\n${url}${preview ? `\n${preview}` : ""}`);
    if (!r.ok) {
      console.warn("webhook failed:", r.detail);
      await recordWebhookFailure(r.detail);
    } else {
      await chrome.storage.local.set({ webhookStatus: null });
    }
  }
}

function updateBadge(watches) {
  const n = Object.values(watches).filter(w => w.changed).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6" });
}

// clicking the notification opens the page
chrome.notifications.onClicked.addListener(url => {
  chrome.tabs.create({ url });
  chrome.notifications.clear(url);
});

chrome.alarms.onAlarm.addListener(alarm => check(alarm.name));

// popup asks for an immediate check after adding a watch
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "checkNow") check(msg.url).then(() => sendResponse(true));
  if (msg.type === "updateBadge") getWatches().then(updateBadge);
  if (msg.type === "testWebhook") {
    sendWebhook(msg.webhook, "Test from Web Monitor — if you can read this, alerts will reach you.")
      .then(async r => {
        if (!r.ok) await recordWebhookFailure(r.detail);
        else await chrome.storage.local.set({ webhookStatus: null });
        sendResponse(r);
      });
  }
  return true; // keep sendResponse alive for async
});

// recreate alarms after browser restart / extension update
async function syncAlarms() {
  const watches = await getWatches();
  for (const [url, w] of Object.entries(watches)) {
    chrome.alarms.create(url, { periodInMinutes: w.interval || 0.5 });
  }
  updateBadge(watches);
}
chrome.runtime.onStartup.addListener(syncAlarms);
chrome.runtime.onInstalled.addListener(syncAlarms);

// test hook only — `module` is undefined in a service worker
if (typeof module !== "undefined" && module.exports) {
  module.exports = { check, extractSelector, isDiscordWebhook, sendWebhook, textFromHtml, diffPreview, phrasePreview };
}
