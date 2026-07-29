// Service worker: the SINGLE WRITER for `watches` and `history`.
//
// Every mutation of those two keys goes through `withWatches`, which serialises
// read-modify-write cycles on a module-level promise chain. The popup never
// writes them — it sends messages that are applied here, inside the queue.
// Network I/O always happens OUTSIDE the queue so a slow page can't stall it.

const PAGE_TIMEOUT_MS = 20000;
const WEBHOOK_TIMEOUT_MS = 10000;
const MAX_TEXT_SNAPSHOT = 5000;
const MAX_PREVIEW = 200;
const MAX_HISTORY = 50;
const MAX_ALERT_ATTEMPTS = 5;
const DEFAULT_INTERVAL = 0.5;

// ------------------------------------------------------------- serialised store

let queue = Promise.resolve();

// Runs `fn({ watches, history })` with exclusive access: nothing else reads or
// writes those keys until it resolves and the result is committed. `fn` must not
// do network I/O — do that before/after and pass the result in.
function withWatches(fn) {
  const run = queue.then(async () => {
    const store = await chrome.storage.local.get(["watches", "history"]);
    const ctx = { watches: store.watches || {}, history: store.history || [] };
    const out = await fn(ctx);
    if (ctx.history.length > MAX_HISTORY) ctx.history = ctx.history.slice(0, MAX_HISTORY);
    await chrome.storage.local.set({ watches: ctx.watches, history: ctx.history });
    return out;
  });
  queue = run.then(() => {}, () => {}); // a failed txn must not poison the chain
  return run;
}

async function readWatches() {
  return (await chrome.storage.local.get("watches")).watches || {};
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// What a stored hash/keyword flag is relative to. If this changes mid-check the
// in-flight result is meaningless and must be discarded.
function identityOf(w) {
  return `${w.selector || ""}\u0000${w.keyword || ""}`;
}

// ---------------------------------------------------------------- html → text

// Markup that is never rendered as page text. A selector must not match inside
// these, and their contents must not contribute to the hash or keyword search.
function stripInert(html) {
  return html
    // script/style bodies first: they are raw text, so a "<!--" inside them lies
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/i, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/, " ")
    .replace(/<(template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(template|noscript)\b[^>]*>[\s\S]*$/i, " ");
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  thinsp: " ", shy: "", zwnj: "", zwj: "", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", minus: "−", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", deg: "°", plusmn: "±", times: "×", divide: "÷",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  dagger: "†", permil: "‰", prime: "′", ne: "≠", le: "≤", ge: "≥",
  larr: "←", rarr: "→", harr: "↔", infin: "∞", check: "✓", star: "★",
};

// Entities are page text, not markup — a keyword watch on "sold out" has to
// match a page that renders "Sold&nbsp;out", and "&amp;" has to become "&".
function decodeEntities(s) {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    const lower = NAMED_ENTITIES[body.toLowerCase()];
    return lower !== undefined ? lower : m;
  });
}

// strip inert markup/tags, decode entities, collapse whitespace
function textFromHtml(html) {
  const stripped = stripInert(html).replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------- tiny selector engine
// DOMParser doesn't exist in a service worker, so this is a small hand-written
// tag scanner. Supported selectors: "#id", ".class", "tag" and combinations
// like "div.price.big" / "span#total". No descendant/child combinators.

class SelectorError extends Error {}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "param", "source", "track", "wbr"]);

// Elements HTML lets you leave unclosed; a following block-level start tag ends them.
const IMPLIED_CLOSE = new Set(["p", "li", "dt", "dd", "td", "th", "tr",
  "thead", "tbody", "tfoot", "option", "optgroup"]);

const BLOCK_TAGS = new Set(["address", "article", "aside", "blockquote", "div", "dl",
  "dd", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "option", "optgroup"]);

// A close tag we never saw opened: if it's a container, it belongs to an ancestor
// and therefore implicitly ends our element.
function isContainer(name) {
  return BLOCK_TAGS.has(name) || name === "body" || name === "html" || name === "template";
}

function parseSelector(sel) {
  const s = (sel || "").trim();
  if (!s) return null;
  if (/[\s>+~[\]:()*,="']/.test(s)) {
    throw new SelectorError(`unsupported selector "${s}" — use #id, .class, tag, or e.g. div.price.big`);
  }
  const parts = s.split(/(?=[#.])/).filter(Boolean);
  let tag = "", id = "";
  const classes = [];
  for (const p of parts) {
    if (p[0] === "#") {
      if (id) throw new SelectorError(`selector "${s}" has more than one #id`);
      if (p.length < 2) throw new SelectorError(`selector "${s}" has an empty #id`);
      id = p.slice(1);
    } else if (p[0] === ".") {
      if (p.length < 2) throw new SelectorError(`selector "${s}" has an empty .class`);
      classes.push(p.slice(1));
    } else {
      if (tag) throw new SelectorError(`unsupported selector "${s}" — one tag name only`);
      tag = p.toLowerCase();
    }
  }
  if (!tag && !id && !classes.length) return null;
  return { tag, id, classes };
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
  if (sel.classes.length) {
    const have = attrValue(tag.raw, "class").split(/\s+/);
    if (!sel.classes.every(c => have.includes(c))) return false;
  }
  return true;
}

// Returns the inner HTML of the first element matching `selector`, or null if
// there is no such element. Throws SelectorError for a malformed selector or an
// element we cannot find an end for — better a visible error than silently
// widening the watch to the whole document.
function extractSelector(html, selector) {
  const sel = parseSelector(selector);
  if (!sel) return null;
  html = stripInert(html); // never match markup that only exists in JS/comments
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return null;
    const tag = readTag(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if (!tag.close && tagMatches(tag, sel)) {
      if (tag.selfClose || VOID_TAGS.has(tag.name)) return "";
      // Walk to the end of the element, tracking open descendants so a nested
      // </span> can't end us and an unmatched parent close can.
      const stack = [];
      let k = tag.end;
      while (k < html.length) {
        const nlt = html.indexOf("<", k);
        if (nlt === -1) break;
        const t = readTag(html, nlt);
        if (!t) { k = nlt + 1; continue; }
        if (t.close) {
          const at = stack.lastIndexOf(t.name);
          if (at !== -1) stack.length = at;            // closes a descendant
          else if (t.name === tag.name) return html.slice(tag.end, nlt); // our own close
          else if (isContainer(t.name)) return html.slice(tag.end, nlt); // a parent's close: implied
          // else: stray inline close (</b> with no <b>) — ignore
        } else if (!t.selfClose && !VOID_TAGS.has(t.name)) {
          if (!stack.length && IMPLIED_CLOSE.has(tag.name) && BLOCK_TAGS.has(t.name)) {
            return html.slice(tag.end, nlt); // <p class="x">…<div> — implied close
          }
          // a repeated <li>/<p>/<td> closes the previous one
          while (stack.length && stack[stack.length - 1] === t.name && IMPLIED_CLOSE.has(t.name)) stack.pop();
          stack.push(t.name);
        }
        k = t.end;
      }
      throw new SelectorError(`selector "${selector}" matched <${tag.name}> but it is never closed — refusing to widen the watch to the whole page`);
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

// One check per URL at a time. A popup "check now" overlapping an alarm tick, or
// a slow check overlapping the next tick, used to produce two notifications, two
// webhook POSTs and two history rows for one change.
const inFlight = new Set();

async function check(url) {
  if (inFlight.has(url)) return { skipped: "in-flight" };
  inFlight.add(url);
  try {
    return await doCheck(url);
  } finally {
    inFlight.delete(url);
  }
}

async function doCheck(url) {
  const snap = await withWatches(({ watches }) => {
    const w = watches[url];
    return w ? { identity: identityOf(w), selector: w.selector, keyword: w.keyword, pending: !!w.pendingAlert } : null;
  });
  if (!snap) return { skipped: "missing" }; // watch was removed; stale alarm

  // An alert committed on a previous tick that never got delivered (worker died,
  // notification threw) is retried here before anything else.
  if (snap.pending) await deliverPending(url);

  const fail = async message => {
    await withWatches(({ watches }) => {
      const w = watches[url];
      if (!w) return;
      w.lastError = message;
      w.lastCheck = Date.now();
    });
    return { error: message };
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

  if (snap.selector) {
    let inner;
    try {
      inner = extractSelector(body, snap.selector);
    } catch (e) {
      if (e instanceof SelectorError) return fail(e.message);
      throw e;
    }
    if (inner === null) return fail(`selector not found: ${snap.selector}`);
    body = inner;
  }

  const text = textFromHtml(body);
  const h = await sha256(text);

  // Commit + decide inside one exclusive txn against FRESH state: the watch may
  // have been re-added with a different selector/keyword, snoozed, or already
  // updated by another check while we were fetching.
  const committed = await withWatches(ctx => {
    const w = ctx.watches[url];
    if (!w) return null;                                  // deleted while we fetched
    if (identityOf(w) !== snap.identity) return null;     // re-added with new terms; our hash is stale

    let title = null, preview = "";
    const present = w.keyword ? text.toLowerCase().includes(w.keyword) : undefined;
    if (w.keyword) {
      if (w.keywordPresent !== undefined && present !== w.keywordPresent) {
        title = `Product status changed — "${w.keyword}" ${present ? "reappeared" : "gone"}`;
        preview = phrasePreview(text, w.keyword, present);
      }
      w.keywordPresent = present;
    } else if (w.lastHash && w.lastHash !== h) {
      title = "Page changed";
      preview = diffPreview(w.lastText || "", text);
    }

    w.lastHash = h;
    w.lastText = text.slice(0, MAX_TEXT_SNAPSHOT);
    w.lastError = null;
    w.lastCheck = Date.now();

    if (!title) return { watches: ctx.watches, alert: null };

    w.changed = true;
    ctx.history.unshift({ ts: Date.now(), url, title, preview });

    // Snoozed watches are still tracked, just not shouted about — nothing to deliver.
    if (w.snoozeUntil > Date.now()) return { watches: ctx.watches, alert: null };

    // Delivery is a separate step; if the worker dies before it lands, the next
    // tick sees pendingAlert and retries instead of silently swallowing the alert.
    w.pendingAlert = { title, preview, attempts: 0 };
    return { watches: ctx.watches, alert: true };
  });

  if (!committed) return { skipped: "stale" };
  updateBadge(committed.watches);
  if (committed.alert) await deliverPending(url);
  return { ok: true, alerted: !!committed.alert };
}

// Delivers (and only then clears) a watch's pendingAlert. Safe to call any time.
async function deliverPending(url) {
  const pending = await withWatches(({ watches }) => {
    const w = watches[url];
    if (!w || !w.pendingAlert) return null;
    w.pendingAlert.attempts = (w.pendingAlert.attempts || 0) + 1;
    if (w.pendingAlert.attempts > MAX_ALERT_ATTEMPTS) {
      w.lastError = "alert could not be delivered";
      delete w.pendingAlert;
      return null;
    }
    return { ...w.pendingAlert };
  });
  if (!pending) return false;

  const { title, preview } = pending;
  try {
    await chrome.notifications.create(url, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title,
      message: preview ? `${url}\n${preview}` : url,
    });
  } catch (e) {
    console.warn("notification failed, will retry:", e);
    return false; // pendingAlert stays put
  }

  await withWatches(({ watches }) => {
    if (watches[url]) delete watches[url].pendingAlert;
  });

  // optional webhook ping (ntfy.sh, discord, ifttt → email, anything that takes a POST).
  // Best-effort: a dead webhook must not make us renotify forever.
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
  return true;
}

function updateBadge(watches) {
  const n = Object.values(watches).filter(w => w.changed).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6" });
}

// ------------------------------------------------------------------- mutations
// Everything the popup can do to `watches`/`history` lives here, inside the queue.

async function addWatch({ url, keyword, selector, interval }) {
  if (selector) {
    try { parseSelector(selector); } catch (e) { return { ok: false, error: e.message }; }
  }
  const iv = Number(interval) || DEFAULT_INTERVAL;
  const kw = (keyword || "").trim().toLowerCase();
  const sel = (selector || "").trim();

  const result = await withWatches(({ watches }) => {
    const prev = watches[url];
    // Re-adding an existing URL is the edit path: keep its baseline, snooze and
    // alert state. Only the terms the hash is relative to invalidate the baseline.
    const w = prev ? { ...prev } : {};
    const termsChanged = !prev || (prev.keyword || "") !== kw || (prev.selector || "") !== sel;
    w.interval = iv;
    if (kw) w.keyword = kw; else delete w.keyword;
    if (sel) w.selector = sel; else delete w.selector;
    if (termsChanged) {
      delete w.lastHash;
      delete w.lastText;
      delete w.keywordPresent;
    }
    watches[url] = w;
    return { ok: true, existed: !!prev, rebaselined: termsChanged, watches };
  });
  chrome.alarms.create(url, { periodInMinutes: iv });
  updateBadge(result.watches);
  return { ok: true, existed: result.existed, rebaselined: result.rebaselined };
}

async function removeWatch(url) {
  const watches = await withWatches(ctx => {
    delete ctx.watches[url];
    return ctx.watches;
  });
  await chrome.alarms.clear(url);
  updateBadge(watches);
  return { ok: true };
}

async function mutate(url, fn) {
  const watches = await withWatches(ctx => {
    if (ctx.watches[url]) fn(ctx.watches[url]);
    return ctx.watches;
  });
  updateBadge(watches);
  return { ok: true };
}

// ------------------------------------------------------------------- messaging

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case "add":          return addWatch(msg);
    case "remove":       return removeWatch(msg.url);
    case "snooze":       return mutate(msg.url, w => { w.snoozeUntil = msg.until || 0; });
    case "clearChanged": return mutate(msg.url, w => { w.changed = false; });
    case "setInterval": {
      const r = await mutate(msg.url, w => { w.interval = Number(msg.interval) || DEFAULT_INTERVAL; });
      chrome.alarms.create(msg.url, { periodInMinutes: Number(msg.interval) || DEFAULT_INTERVAL });
      return r;
    }
    case "checkNow":     return check(msg.url);
    case "clearHistory": return withWatches(ctx => { ctx.history.length = 0; }).then(() => ({ ok: true }));
    case "updateBadge":  return readWatches().then(w => { updateBadge(w); return { ok: true }; });
    case "setWebhook":
      await chrome.storage.local.set({ webhook: (msg.webhook || "").trim(), webhookStatus: null });
      return { ok: true };
    case "testWebhook": {
      const r = await sendWebhook(msg.webhook, "Test from Web Monitor — if you can read this, alerts will reach you.");
      if (!r.ok) await recordWebhookFailure(r.detail);
      else await chrome.storage.local.set({ webhookStatus: null });
      return r;
    }
    default: return { ok: false, error: `unknown message: ${msg && msg.type}` };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse, e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // keep sendResponse alive for async
  });

  // clicking the notification opens the page
  chrome.notifications.onClicked.addListener(url => {
    chrome.tabs.create({ url });
    chrome.notifications.clear(url);
  });

  chrome.alarms.onAlarm.addListener(alarm => check(alarm.name));
  chrome.runtime.onStartup.addListener(syncAlarms);
  chrome.runtime.onInstalled.addListener(syncAlarms);
}

// recreate alarms after browser restart / extension update, and prune alarms
// left behind by watches that no longer exist
async function syncAlarms() {
  const watches = await readWatches();
  const existing = await chrome.alarms.getAll();
  for (const a of existing || []) {
    if (!watches[a.name]) await chrome.alarms.clear(a.name);
  }
  for (const [url, w] of Object.entries(watches)) {
    chrome.alarms.create(url, { periodInMinutes: w.interval || DEFAULT_INTERVAL });
  }
  updateBadge(watches);
  // deliver anything a previous worker instance committed but never sent
  for (const [url, w] of Object.entries(watches)) {
    if (w.pendingAlert) await deliverPending(url);
  }
}

// test hook only — `module` is undefined in a service worker
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    check, deliverPending, handleMessage, addWatch, removeWatch, mutate, syncAlarms,
    withWatches, extractSelector, parseSelector, stripInert, decodeEntities,
    isDiscordWebhook, sendWebhook, textFromHtml, diffPreview, phrasePreview,
    SelectorError,
  };
}
