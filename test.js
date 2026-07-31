"use strict";
// node test.js
//
// Dependency-free. The chrome APIs and fetch are hand-rolled stubs below; there
// is no jsdom, so this covers the service worker only.

const assert = require("assert");

// The worker warns loudly about blocked notifications and dead webhooks. Several
// tests exist precisely to provoke that, so keep the log for a failure dump only.
const warned = [];
console.warn = (...a) => warned.push(a.map(String).join(" "));

// ------------------------------------------------------------------ stubs

// get() clones, exactly as the real API does: handing back a live reference
// would let two racing readers share one object and quietly paper over the
// lost-update bugs these tests exist to catch.
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

let LATENCY = 0; // ms of randomised storage latency, for the concurrency guard
const jitter = () => (LATENCY ? new Promise(r => setTimeout(r, Math.random() * LATENCY)) : null);

let writes = 0; // storage writes, to prove read-only transactions don't do any

const store = {
  _d: {},
  async get(keys) {
    await jitter();
    const ks = typeof keys === "string" ? [keys] : keys;
    const out = {};
    for (const k of ks) if (this._d[k] !== undefined) out[k] = clone(this._d[k]);
    return out;
  },
  async set(o) {
    await jitter();
    writes++;
    Object.assign(this._d, clone(o));
  },
  async remove(k) { delete this._d[k]; },
};

const alarms = new Map();
const notes = [];       // notifications actually created
let notifyThrows = false;
const badge = { text: "", color: "" };

global.chrome = {
  storage: { local: store, onChanged: { addListener() {} } },
  alarms: {
    create(name, opts) { alarms.set(name, opts); },
    async clear(name) { return alarms.delete(name); },
    async getAll() { return [...alarms].map(([name, o]) => ({ name, ...o })); },
    onAlarm: { addListener() {} },
  },
  notifications: {
    async create(id, opts) {
      if (notifyThrows) throw new Error("notifications are blocked");
      notes.push({ id, ...opts });
      return id;
    },
    async clear() {},
    onClicked: { addListener() {} },
  },
  action: {
    setBadgeText(o) { badge.text = o.text; },
    setBadgeBackgroundColor(o) { badge.color = o.color; },
  },
  tabs: { create() {} },
  runtime: {
    onMessage: { addListener() {} },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
  },
};

// fetch: page requests answered by `pageHandler`, webhook POSTs recorded.
const posts = [];
const fetchLog = [];
let pageHandler = () => htmlRes(PAGE("In stock"));

function htmlRes(body, opts = {}) {
  return {
    ok: opts.ok !== undefined ? opts.ok : (opts.status === undefined || opts.status < 300),
    status: opts.status || 200,
    statusText: "OK",
    url: opts.url,
    headers: { get: n => (n.toLowerCase() === "content-type" ? (opts.ct === undefined ? "text/html; charset=utf-8" : opts.ct) : null) },
    async text() { return body; },
  };
}

global.fetch = async (url, init) => {
  fetchLog.push({ url, init });
  if (String(url).startsWith("https://hook.example")) {
    posts.push({ url, body: init && init.body });
    return { ok: true, status: 204, statusText: "No Content", url, headers: { get: () => null }, async text() { return ""; } };
  }
  const r = await pageHandler(url, init);
  if (r.url === undefined) r.url = url;
  return r;
};

const bg = require("./background.js");

// ------------------------------------------------------------------ runner

let pass = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push({ name, msg: (e && e.message) || String(e) });
  }
}

const PAGE = t => `<!doctype html><html><head><title>Widget</title></head><body>` +
  `<div id="stock">${t}</div><p>Ordinary product copy, long enough to look like a real page, ` +
  `with plenty of perfectly boring words in it.</p></body></html>`;

const URL1 = "https://shop.example/item";

async function reset() {
  store._d = {};
  alarms.clear();
  notes.length = 0;
  posts.length = 0;
  fetchLog.length = 0;
  notifyThrows = false;
  LATENCY = 0;
  badge.text = "";
  writes = 0;
  pageHandler = () => htmlRes(PAGE("In stock"));
}

// a keyword watch on "sold out", baselined as PRESENT
async function keywordWatch(url = URL1) {
  await bg.addWatch({ url, keyword: "sold out", interval: 0.5 });
  pageHandler = () => htmlRes(PAGE("Sold out"));
  await bg.check(url);
  const w = (await store.get("watches")).watches[url];
  assert.strictEqual(w.keywordPresent, true, "baseline should see the phrase");
  notes.length = 0; posts.length = 0;
  return url;
}

const watchOf = async (url = URL1) => (await store.get("watches")).watches[url];
const text = html => bg.textFromHtml(html);

// ================================================================== P1-1
// stripInert: fake content must never leak, real content must never vanish.

async function stripInertBattery() {
  await test("P1-1a <script> inside a comment does not delete the document", () => {
    const t = text(`<p>A</p><!-- todo: re-enable <script src="x.js"> --><p>IN STOCK</p>`);
    assert.strictEqual(t, "A IN STOCK");
  });

  await test("P1-1a commented-out </script> does not delete the document", () => {
    const t = text(`<p>A</p><!-- was: <script>x()</script> --><p>IN STOCK</p>`);
    assert.strictEqual(t, "A IN STOCK");
  });

  await test("P1-1b <!--> is an empty comment, not an unterminated one", () => {
    assert.strictEqual(text(`<p>A</p><!--><p>IN STOCK</p>`), "A IN STOCK");
  });

  await test("P1-1b <!---> is an empty comment, not an unterminated one", () => {
    assert.strictEqual(text(`<p>A</p><!---><p>IN STOCK</p>`), "A IN STOCK");
  });

  await test("a comment inside <script> does not leak script source", () => {
    const t = text(`<p>A</p><script>var x = "<!-- "; bad();</script><p>IN STOCK</p>`);
    assert.strictEqual(t, "A IN STOCK");
  });

  await test("<template> holding </template> in a JS string hides its whole subtree", () => {
    const t = text(`<template><script>var t = "</template>";</script><p>FAKE PRICE</p></template><p>REAL</p>`);
    assert.ok(!/FAKE/.test(t), `template contents leaked: ${t}`);
    assert.strictEqual(t, "REAL");
  });

  await test("nested <template> is skipped to the right depth", () => {
    const t = text(`<template><template><p>FAKE</p></template><p>ALSO FAKE</p></template><p>REAL</p>`);
    assert.strictEqual(t, "REAL");
  });

  await test("unclosed <script> hides only what follows it", () => {
    assert.strictEqual(text(`<p>A</p><script>var a = 1; leaked()`), "A");
  });

  await test("unterminated comment keeps the text before it", () => {
    assert.strictEqual(text(`<p>A</p><!-- unclosed <p>B</p>`), "A");
  });

  await test("CDATA contents are dropped, and ]]> does not leak", () => {
    const t = text(`<p>A</p><![CDATA[ secret ]]><p>B</p>`);
    assert.strictEqual(t, "A B");
  });

  await test("uppercase and mixed-case SCRIPT/STYLE are stripped", () => {
    const t = text(`<P>A</P><SCRIPT>bad()</SCRIPT><ScRiPt>evil()</ScRiPt><STYLE>.x{}</STYLE><p>B</p>`);
    assert.strictEqual(t, "A B");
  });

  await test("uppercase TEMPLATE/NOSCRIPT are stripped", () => {
    assert.strictEqual(text(`<TEMPLATE><p>FAKE</p></TEMPLATE><NOSCRIPT>NOPE</NOSCRIPT><p>B</p>`), "B");
  });

  await test('an attribute value containing ">" does not leak into the text', () => {
    const t = text(`<div title="a > b">C</div>`);
    assert.strictEqual(t, "C");
  });

  await test("an attribute value containing <script> swallows nothing", () => {
    const t = text(`<div data-x="<script>">C</div><p>D</p><script>bad()</script><p>E</p>`);
    assert.strictEqual(t, "C D E");
  });

  await test("an attribute value containing a single-quoted > is handled", () => {
    assert.strictEqual(text(`<div title='a > b'>C</div><p>D</p>`), "C D");
  });

  await test("a stray < in page text survives", () => {
    assert.ok(/6 items/.test(text(`<p>5 < 6 items left</p>`)));
  });

  await test("doctype and processing instructions leave no residue", () => {
    assert.strictEqual(text(`<!DOCTYPE html><?xml version="1.0"?><p>A</p>`), "A");
  });

  await test("a realistic page keeps all of its real text", () => {
    const html = `<!doctype html><html><head><style>.a{}</style><script>var j={"p":"999"}</script></head>` +
      `<body><!-- header --><h1>Widget</h1><div class="price">$12.50</div>` +
      `<noscript>enable js</noscript><template><div class="price">$0.00</div></template>` +
      `<p title="a>b">Sold out</p><script>t()</script></body></html>`;
    assert.strictEqual(text(html), "Widget $12.50 Sold out");
  });

  await test("stripInert keeps element tags when not dropping them", () => {
    const out = bg.stripInert(`<div id="x"><!-- c --><script>q()</script><b>hi</b></div>`);
    assert.ok(out.includes('<div id="x">') && out.includes("<b>"), out);
    assert.ok(!out.includes("q()") && !out.includes("c"), out);
  });

  await test("a selector cannot match markup that exists only in a comment", () => {
    const html = `<!-- <div id="price">FAKE</div> --><div id="price">REAL</div>`;
    assert.strictEqual(bg.extractSelector(html, "#price").trim(), "REAL");
  });

  // P2-9
  await test('P2-9 <a href=/> is not treated as self-closing', () => {
    assert.strictEqual(bg.extractSelector(`<a id="home" href=/>Home</a>`, "#home"), "Home");
  });

  await test("real self-closing tags still self-close", () => {
    assert.strictEqual(bg.extractSelector(`<div id="a"/><p>x</p>`, "#a"), "");
    assert.strictEqual(bg.readTag(`<br />`, 0).selfClose, true);
    assert.strictEqual(bg.readTag(`<img src=x/>`, 0).selfClose, false);
  });
}

// ================================================================== P1-2
// A 200 is not a page.

async function bodyValidation() {
  const noAlert = async (label, w) => {
    assert.strictEqual(notes.length, 0, `${label}: fired ${notes.length} notification(s)`);
    assert.ok(w.lastError, `${label}: no check error recorded`);
    assert.strictEqual(w.keywordPresent, true, `${label}: flipped the phrase to absent`);
  };

  await test("P1-2 an empty 200 body is a check error, not a restock", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes("");
    await bg.check(URL1);
    await noAlert("empty body", await watchOf());
  });

  await test("P1-2 a Cloudflare interstitial is a check error, not a restock", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes(`<!doctype html><html><head><title>Just a moment...</title></head>` +
      `<body><div id="challenge-running">Checking your browser before accessing the site. ` +
      `This process is automatic. Your browser will redirect shortly.</div></body></html>`);
    await bg.check(URL1);
    const w = await watchOf();
    await noAlert("interstitial", w);
    assert.ok(/bot check|interstitial/i.test(w.lastError), w.lastError);
  });

  await test("P1-2 a redirect to /login is a check error, not a restock", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes(PAGE("Please sign in to continue to your account dashboard"), { url: "https://shop.example/login" });
    await bg.check(URL1);
    const w = await watchOf();
    await noAlert("login redirect", w);
    assert.ok(/redirected/.test(w.lastError), w.lastError);
  });

  await test("P1-2 a non-HTML content-type is a check error", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes(PAGE("In stock"), { ct: "application/json" });
    await bg.check(URL1);
    await noAlert("json", await watchOf());
  });

  await test("P1-2 a >70% collapse in extracted text is an error, not a change", async () => {
    await reset(); await keywordWatch();
    const before = await watchOf();
    pageHandler = () => htmlRes(`<!doctype html><html><body><!-- ${"pad ".repeat(40)} --><p>x</p></body></html>`);
    await bg.check(URL1);
    const w = await watchOf();
    await noAlert("collapse", w);
    assert.ok(/collapsed/.test(w.lastError), w.lastError);
    assert.strictEqual(w.lastHash, before.lastHash, "a collapsed page must not become the new baseline");
  });

  await test("a same-path https redirect is still accepted", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes(PAGE("Sold out"), { url: "https://shop.example/item/" });
    const r = await bg.check(URL1);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual((await watchOf()).lastError, null);
  });

  await test("a genuine restock still alerts", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes(PAGE("In stock, ships today"));
    await bg.check(URL1);
    assert.strictEqual(notes.length, 1, "the real restock must still fire");
    assert.ok(/gone/.test(notes[0].title), notes[0].title);
  });

  await test("P3 no forbidden user-agent header is sent", async () => {
    await reset(); await keywordWatch();
    const h = (fetchLog[0].init || {}).headers || {};
    assert.ok(!Object.keys(h).some(k => k.toLowerCase() === "user-agent"), JSON.stringify(h));
  });
}

// ================================================================== P1-3 / P2-3
// Notification and webhook are independent; giving up is sticky.

async function delivery() {
  await test("P1-3 the webhook is POSTed even when notifications throw", async () => {
    await reset(); await keywordWatch();
    await store.set({ webhook: "https://hook.example/abc" });
    notifyThrows = true;
    pageHandler = () => htmlRes(PAGE("In stock now"));
    await bg.check(URL1);
    assert.strictEqual(posts.length, 1, `expected 1 webhook POST, got ${posts.length}`);
    assert.ok(/gone/.test(posts[0].body), posts[0].body);
    assert.strictEqual((await watchOf()).pendingAlert, undefined, "webhook delivery should clear the pending alert");
  });

  await test("P1-3 a notification is still sent when the webhook fails", async () => {
    await reset(); await keywordWatch();
    await store.set({ webhook: "not a url" });
    pageHandler = () => htmlRes(PAGE("In stock now"));
    await bg.check(URL1);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual((await watchOf()).pendingAlert, undefined);
  });

  await test("P2-3/P1-3 giving up is sticky and survives a later successful check", async () => {
    await reset(); await keywordWatch();
    notifyThrows = true; // and no webhook configured: nothing can be delivered
    pageHandler = () => htmlRes(PAGE("In stock now"));
    await bg.check(URL1);
    assert.ok((await watchOf()).pendingAlert, "first failure should leave the alert pending");
    for (let i = 0; i < bg.CONST.MAX_ALERT_ATTEMPTS; i++) await bg.deliverPending(URL1);

    const w = await watchOf();
    assert.ok(w.alertFailure, "after the attempt cap there must be a visible, sticky failure");
    assert.ok(/gone/.test(w.alertFailure.title), w.alertFailure.title);

    notifyThrows = false;
    pageHandler = () => htmlRes(PAGE("In stock now, plenty available"));
    await bg.check(URL1);
    const w2 = await watchOf();
    assert.ok(w2.alertFailure, "a later successful check must NOT erase the delivery failure");
    assert.strictEqual(w2.lastError, null);
    assert.ok(badge.text.includes("!"), `badge should flag the broken watch, got "${badge.text}"`);
  });

  await test("P2-2 concurrent deliverPending sends exactly one notification and one POST", async () => {
    await reset(); await keywordWatch();
    await store.set({ webhook: "https://hook.example/abc" });
    LATENCY = 6;
    await bg.withWatches(({ watches }) => {
      watches[URL1].pendingAlert = { title: "Page changed", preview: "p", attempts: 0 };
    });
    await Promise.all([bg.deliverPending(URL1), bg.deliverPending(URL1), bg.deliverPending(URL1), bg.deliverPending(URL1)]);
    LATENCY = 0;
    assert.strictEqual(notes.length, 1, `expected 1 notification, got ${notes.length}`);
    assert.strictEqual(posts.length, 1, `expected 1 webhook POST, got ${posts.length}`);
  });
}

// ================================================================== P1-4
// A dead watch says so.

async function deadWatch() {
  await test("P1-4 lastSuccess is distinct from lastCheck", async () => {
    await reset(); await keywordWatch();
    const ok = await watchOf();
    assert.ok(ok.lastSuccess > 0, "a successful check must stamp lastSuccess");
    await new Promise(r => setTimeout(r, 5));
    pageHandler = () => htmlRes("nope", { status: 403 });
    await bg.check(URL1);
    const bad = await watchOf();
    assert.strictEqual(bad.lastSuccess, ok.lastSuccess, "a failure must not advance lastSuccess");
    assert.ok(bad.lastCheck > bad.lastSuccess, "a failure must advance lastCheck");
    assert.strictEqual(bad.lastError, "HTTP 403");
  });

  await test("P1-4 N consecutive failures raise a notification and a history row", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes("nope", { status: 403 });
    for (let i = 0; i < bg.CONST.DEAD_AFTER_FAILURES; i++) await bg.check(URL1);
    assert.strictEqual(notes.length, 1, `expected exactly 1 dead-watch notification, got ${notes.length}`);
    assert.ok(/stopped working/i.test(notes[0].title), notes[0].title);
    assert.ok(/403/.test(notes[0].title), notes[0].title);
    const w = await watchOf();
    assert.strictEqual(w.dead, true);
    const { history } = await store.get("history");
    assert.ok(history.some(h => h.kind === "dead"), "dead watch should appear in history");
    assert.ok(badge.text.includes("!"), `badge should distinguish a broken watch, got "${badge.text}"`);
  });

  await test("P1-4 a dead watch does not renotify on every subsequent failure", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes("nope", { status: 403 });
    for (let i = 0; i < bg.CONST.DEAD_AFTER_FAILURES + 4; i++) await bg.check(URL1);
    assert.strictEqual(notes.length, 1, `expected 1 notification, got ${notes.length}`);
  });

  await test("P1-4 the dead-watch alert also goes to the webhook", async () => {
    await reset(); await keywordWatch();
    await store.set({ webhook: "https://hook.example/abc" });
    pageHandler = () => htmlRes("nope", { status: 500 });
    for (let i = 0; i < bg.CONST.DEAD_AFTER_FAILURES; i++) await bg.check(URL1);
    assert.strictEqual(posts.length, 1, `expected 1 webhook POST, got ${posts.length}`);
    assert.ok(/stopped working/i.test(posts[0].body), posts[0].body);
  });

  await test("P1-4 recovery clears the dead state", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes("nope", { status: 403 });
    for (let i = 0; i < bg.CONST.DEAD_AFTER_FAILURES; i++) await bg.check(URL1);
    pageHandler = () => htmlRes(PAGE("Sold out"));
    await bg.check(URL1);
    const w = await watchOf();
    assert.strictEqual(w.dead, false);
    assert.strictEqual(w.failCount, 0);
    assert.strictEqual(w.lastError, null);
  });
}

// ================================================================== P2-7
// Throttling and fair history.

async function throttling() {
  await test("P2-7 an always-changing page produces one alert per cooldown", async () => {
    await reset();
    await bg.addWatch({ url: URL1, interval: 0.5 });
    let n = 0;
    pageHandler = () => htmlRes(PAGE(`Now showing revision number ${n++}`));
    for (let i = 0; i < 25; i++) await bg.check(URL1);
    assert.strictEqual(notes.length, 1, `expected 1 notification across 25 ticks, got ${notes.length}`);
    const { history } = await store.get("history");
    assert.strictEqual(history.length, 1, `expected 1 history row, got ${history.length}`);
    const w = await watchOf();
    assert.ok(w.throttled >= 20, `suppressed changes should be counted, got ${w.throttled}`);
    assert.strictEqual(w.changed, true, "the watch is still marked changed");
  });

  await test("P2-7 history eviction is fair per watch", async () => {
    const rows = [];
    let ts = 1000;
    for (let i = 0; i < 60; i++) rows.push({ ts: ts++, url: "https://noisy.example/", title: `n${i}` });
    rows.push({ ts: ts++, url: "https://quiet.example/", title: "quiet-1" });
    rows.push({ ts: ts++, url: "https://other.example/", title: "other-1" });
    const out = bg.trimHistory(rows.slice().reverse()); // newest-first
    assert.ok(out.some(r => r.title === "quiet-1"), "a quiet watch's row must survive a noisy neighbour");
    assert.ok(out.some(r => r.title === "other-1"));
    const noisy = out.filter(r => r.url === "https://noisy.example/").length;
    assert.ok(noisy <= bg.CONST.MAX_HISTORY_PER_WATCH, `per-watch cap not applied: ${noisy}`);
    assert.ok(out.length <= bg.CONST.MAX_HISTORY);
  });
}

// ================================================================== queue guard
// The single-writer architecture must not silently rot.

async function concurrencyGuard() {
  await test("GUARD withWatches runs strictly one transaction at a time", async () => {
    await reset();
    LATENCY = 4;
    let inside = 0, peak = 0, done = 0;
    await Promise.all(Array.from({ length: 50 }, () =>
      bg.withWatches(async ctx => {
        inside++; peak = Math.max(peak, inside);
        await new Promise(r => setTimeout(r, Math.random() * 4));
        ctx.watches.counter = { n: ((ctx.watches.counter && ctx.watches.counter.n) || 0) + 1 };
        done++;
        inside--;
      })));
    LATENCY = 0;
    assert.strictEqual(peak, 1, `two transactions overlapped (peak ${peak})`);
    const w = await store.get("watches");
    assert.strictEqual(w.watches.counter.n, 50, `lost updates: ${w.watches.counter.n}/50`);
    assert.strictEqual(done, 50);
  });

  await test("GUARD 36 snoozes interleaved with 36 checks lose nothing", async () => {
    await reset();
    const urls = Array.from({ length: 36 }, (_, i) => `https://s.example/i${i}`);
    for (const u of urls) await bg.addWatch({ url: u, interval: 0.5 });
    pageHandler = () => htmlRes(PAGE("Sold out"));
    LATENCY = 5;
    const ops = [];
    urls.forEach((u, i) => {
      ops.push(bg.handleMessage({ type: "snooze", url: u, until: 5_000_000 + i }));
      ops.push(bg.check(u));
      ops.push(bg.handleMessage({ type: "clearChanged", url: u }));
    });
    await Promise.all(ops.sort(() => Math.random() - 0.5));
    LATENCY = 0;
    const { watches } = await store.get("watches");
    const lost = urls.filter((u, i) => !watches[u] || watches[u].snoozeUntil !== 5_000_000 + i);
    assert.strictEqual(lost.length, 0, `lost snoozes ${lost.length}/36`);
  });
}

// ================================================================== P2 / P3 misc

async function misc() {
  await test("P2-6 removing a watch returns it so the popup can undo", async () => {
    await reset();
    await bg.addWatch({ url: URL1, keyword: "sold out", interval: 5 });
    const r = await bg.handleMessage({ type: "remove", url: URL1 });
    assert.ok(r.watch && r.watch.keyword === "sold out", JSON.stringify(r));
    assert.strictEqual(await watchOf(), undefined);
    await bg.handleMessage({ type: "restoreWatch", url: URL1, watch: r.watch });
    const back = await watchOf();
    assert.ok(back && back.keyword === "sold out", "undo must restore the watch");
    assert.ok(alarms.has(URL1), "undo must restore the alarm too");
  });

  await test("P2-6 restore never overwrites something newer", async () => {
    await reset();
    await bg.addWatch({ url: URL1, keyword: "sold out", interval: 5 });
    const r = await bg.handleMessage({ type: "remove", url: URL1 });
    await bg.addWatch({ url: URL1, keyword: "in stock", interval: 5 });
    await bg.handleMessage({ type: "restoreWatch", url: URL1, watch: r.watch });
    assert.strictEqual((await watchOf()).keyword, "in stock", "undo must not clobber a newer watch");
  });

  await test("P2-6 clearing history returns the rows, and restore puts back only those", async () => {
    await reset();
    await bg.withWatches(ctx => {
      ctx.history.push({ ts: 3, url: "u", title: "c" }, { ts: 2, url: "u", title: "b" }, { ts: 1, url: "u", title: "a" });
    });
    const r = await bg.handleMessage({ type: "clearHistory" });
    assert.strictEqual(r.rows.length, 3);
    assert.strictEqual((await store.get("history")).history.length, 0);
    await bg.withWatches(ctx => { ctx.history.push({ ts: 9, url: "u", title: "new" }); });
    await bg.handleMessage({ type: "restoreHistory", rows: r.rows });
    const { history } = await store.get("history");
    assert.strictEqual(history.length, 4, "restore should add back exactly the cleared rows");
    assert.strictEqual(history[0].title, "new", "history stays newest-first");
  });

  await test("P3 URL normalisation makes …/p and …/p/ one watch", async () => {
    await reset();
    await bg.addWatch({ url: "https://Shop.Example/p/", interval: 5 });
    await bg.addWatch({ url: "https://shop.example/p#frag", interval: 5 });
    const { watches } = await store.get("watches");
    assert.strictEqual(Object.keys(watches).length, 1, JSON.stringify(Object.keys(watches)));
    assert.strictEqual(bg.normalizeUrl("https://a.com:443/x/"), "https://a.com/x");
  });

  await test("P3 migration stamps a schema version and backfills new fields", async () => {
    await reset();
    await store.set({
      watches: { "https://old.example/p/": { keyword: "sold out", lastHash: "abc", lastText: "hello", lastCheck: 1234 } },
      history: [],
    });
    await bg.migrate();
    const { watches } = await store.get("watches");
    const w = watches["https://old.example/p"];
    assert.ok(w, `key not normalised: ${Object.keys(watches)}`);
    assert.strictEqual(w.failCount, 0);
    assert.strictEqual(w.lastSuccess, 1234);
    assert.strictEqual(w.lastLen, 5);
    assert.strictEqual((await store.get("schemaVersion")).schemaVersion, bg.CONST.SCHEMA_VERSION);
  });

  await test("P3 the dead setInterval message is gone", async () => {
    await reset();
    const r = await bg.handleMessage({ type: "setInterval", url: URL1, interval: 5 });
    assert.strictEqual(r.ok, false, "setInterval should no longer be a live message type");
  });

  await test("a snoozed watch records the change but sends nothing", async () => {
    await reset(); await keywordWatch();
    await bg.handleMessage({ type: "snooze", url: URL1, until: Date.now() + 3600000 });
    pageHandler = () => htmlRes(PAGE("In stock"));
    await bg.check(URL1);
    assert.strictEqual(notes.length, 0);
    assert.strictEqual((await watchOf()).changed, true);
  });
}

// ================================================================== audit fixes
// The 2026-07-30 audit: a mute must delay alerts, never eat them; an attribute
// name must not be readable out of another attribute's value; a clean
// transaction must not write.

async function auditFixes() {
  await test("AUDIT attrValue is quote-aware — an id inside a title does not shadow the real one", () => {
    const html = `<div title="the id = 5 thing" id="real">FOUND</div>`;
    assert.strictEqual(bg.extractSelector(html, "#real"), "FOUND");
    assert.strictEqual(bg.extractSelector(html, "#5"), null, "a value fragment must not match as an id");
  });

  await test("AUDIT single quotes, unquoted values and boolean attributes all parse", () => {
    assert.strictEqual(bg.extractSelector(`<div data-x='id=9' id='q'>A</div>`, "#q"), "A");
    assert.strictEqual(bg.extractSelector(`<div hidden id=r class="a b">B</div>`, "#r"), "B");
    assert.strictEqual(bg.extractSelector(`<div hidden id=r class="a b">B</div>`, "div.a.b"), "B");
    assert.strictEqual(bg.extractSelector(`<div title="class=zz" class="yy">C</div>`, ".zz"), null);
  });

  await test("AUDIT a change while snoozed is delivered once the snooze expires", async () => {
    await reset(); await keywordWatch();
    await bg.handleMessage({ type: "snooze", url: URL1, until: Date.now() + 3600000 });
    pageHandler = () => htmlRes(PAGE("In stock"));
    await bg.check(URL1);
    assert.strictEqual(notes.length, 0, "a muted watch must not notify");
    const muted = await watchOf();
    assert.ok(muted.pendingAlert, "the alert must be queued, not dropped");
    assert.ok(muted.lastAlertAt, "the cooldown stamp is committed with the queued alert");

    // the snooze runs out; the next check delivers what was queued
    await bg.withWatches(({ watches }) => { watches[URL1].snoozeUntil = Date.now() - 1; });
    await bg.check(URL1);
    assert.strictEqual(notes.length, 1, `expected exactly 1 notification after expiry, got ${notes.length}`);
    assert.ok(/gone/.test(notes[0].title), notes[0].title);
    assert.strictEqual((await watchOf()).pendingAlert, undefined, "delivery must clear the queued alert");
  });

  await test("AUDIT unmuting delivers the alert that queued while muted", async () => {
    await reset(); await keywordWatch();
    await bg.handleMessage({ type: "snooze", url: URL1, until: Date.now() + 3600000 });
    pageHandler = () => htmlRes(PAGE("In stock"));
    await bg.check(URL1);
    assert.strictEqual(notes.length, 0);
    await bg.handleMessage({ type: "snooze", url: URL1, until: 0 });
    assert.strictEqual(notes.length, 1, `unmute must flush the queued alert, got ${notes.length}`);
  });

  await test("AUDIT a watch that dies while snoozed still alerts after expiry", async () => {
    await reset(); await keywordWatch();
    await bg.handleMessage({ type: "snooze", url: URL1, until: Date.now() + 3600000 });
    pageHandler = () => htmlRes("nope", { status: 403 });
    for (let i = 0; i < bg.CONST.DEAD_AFTER_FAILURES; i++) await bg.check(URL1);
    assert.strictEqual(notes.length, 0, "a muted watch must not notify its death either");
    const w = await watchOf();
    assert.strictEqual(w.dead, true);
    assert.ok(w.pendingAlert, "the dead-watch alert must be queued");
    const { history } = await store.get("history");
    assert.ok(history.some(h => h.kind === "dead"), "history records it immediately");

    await bg.withWatches(({ watches }) => { watches[URL1].snoozeUntil = Date.now() - 1; });
    await bg.check(URL1);
    assert.strictEqual(notes.length, 1, `expected 1 dead-watch notification after expiry, got ${notes.length}`);
    assert.ok(/stopped working/i.test(notes[0].title), notes[0].title);
  });

  await test("AUDIT a dead-watch alert reads as an age, not an ISO timestamp", async () => {
    await reset(); await keywordWatch();
    pageHandler = () => htmlRes("nope", { status: 403 });
    for (let i = 0; i < bg.CONST.DEAD_AFTER_FAILURES; i++) await bg.check(URL1);
    const { history } = await store.get("history");
    const dead = history.find(h => h.kind === "dead");
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(dead.preview), `raw timestamp in preview: ${dead.preview}`);
    assert.ok(/ago|never/.test(dead.preview), dead.preview);
  });

  await test("AUDIT diffPreview says so when the change is past the stored snapshot", () => {
    const cap = bg.CONST.MAX_TEXT_SNAPSHOT;
    const old = "a".repeat(cap);
    const note = bg.diffPreview(old, old + " the actual change is out here");
    assert.ok(/beyond the stored/.test(note), note);
    // and a change inside the snapshot still shows the change, not the boundary
    const changed = "a".repeat(100) + "NOW IN STOCK" + "a".repeat(cap);
    assert.ok(/NOW IN STOCK/.test(bg.diffPreview(old, changed)), bg.diffPreview(old, changed));
  });

  await test("AUDIT a read-only transaction writes nothing", async () => {
    await reset();
    await bg.addWatch({ url: URL1, interval: 5 });
    writes = 0;
    await bg.withWatches(({ watches }) => (watches[URL1] ? { seen: true } : null));
    assert.strictEqual(writes, 0, `a snapshot read wrote ${writes} time(s)`);
    // mutating a watch that no longer exists is read-only too, and says so
    const r = await bg.handleMessage({ type: "clearChanged", url: "https://gone.example/x" });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.gone, true, JSON.stringify(r));
    assert.strictEqual(writes, 0, `a missing-watch mutation wrote ${writes} time(s)`);
    // a real mutation still writes
    await bg.handleMessage({ type: "clearChanged", url: URL1 });
    assert.ok(writes > 0, "a real mutation must still write");
  });

  await test("AUDIT the badge separates a count of changes from a broken watch", async () => {
    await reset();
    await bg.withWatches(ctx => {
      ctx.watches["https://a.example/"] = { changed: true };
      ctx.watches["https://b.example/"] = { changed: true };
      ctx.watches["https://c.example/"] = { dead: true };
    });
    bg.updateBadge((await store.get("watches")).watches);
    assert.strictEqual(badge.text, "2!", `expected "2!", got "${badge.text}"`);

    await bg.withWatches(ctx => { delete ctx.watches["https://c.example/"]; });
    bg.updateBadge((await store.get("watches")).watches);
    assert.strictEqual(badge.text, "2", `expected "2", got "${badge.text}"`);
  });

  await test("AUDIT the interval floor holds against the message API", async () => {
    await reset();
    await bg.handleMessage({ type: "add", url: URL1, interval: 0.001 });
    assert.strictEqual((await watchOf()).interval, bg.CONST.MIN_INTERVAL);
    assert.strictEqual(alarms.get(URL1).periodInMinutes, bg.CONST.MIN_INTERVAL);
    await bg.handleMessage({ type: "add", url: URL1, interval: -5 });
    assert.strictEqual((await watchOf()).interval, bg.CONST.MIN_INTERVAL);
    await bg.handleMessage({ type: "add", url: URL1, interval: "nonsense" });
    assert.strictEqual((await watchOf()).interval, bg.CONST.DEFAULT_INTERVAL, "an unparseable interval falls back to the default");
  });

  await test("AUDIT a missing interval defaults to 5 minutes, not 30 seconds", async () => {
    await reset();
    assert.strictEqual(bg.CONST.DEFAULT_INTERVAL, 5);
    await bg.addWatch({ url: URL1 });
    assert.strictEqual((await watchOf()).interval, 5);
  });

  await test("AUDIT re-adding a URL reports whether the baseline survived", async () => {
    await reset();
    const first = await bg.addWatch({ url: URL1, keyword: "sold out", interval: 5 });
    assert.strictEqual(first.existed, false);
    const same = await bg.addWatch({ url: URL1, keyword: "sold out", interval: 15 });
    assert.deepStrictEqual([same.existed, same.rebaselined], [true, false], JSON.stringify(same));
    const retermed = await bg.addWatch({ url: URL1, keyword: "in stock", interval: 15 });
    assert.deepStrictEqual([retermed.existed, retermed.rebaselined], [true, true], JSON.stringify(retermed));
  });

  await test("AUDIT phrase preview lines up on a string whose lowercase is longer", () => {
    // "İ" lowercases to TWO code points, so an index found in a lowercased copy
    // points 200 characters past the phrase in the original.
    const text = "İ".repeat(200) + " SOLD OUT today " + "z".repeat(400);
    const p = bg.phrasePreview(text, "sold out", true);
    assert.ok(/SOLD OUT today/.test(p), `context missed the phrase: ${p}`);
  });
}

// ------------------------------------------------------------------ go

(async () => {
  await stripInertBattery();
  await bodyValidation();
  await delivery();
  await deadWatch();
  await throttling();
  await concurrencyGuard();
  await misc();
  await auditFixes();

  const total = pass + failures.length;
  if (failures.length) {
    console.log("");
    for (const f of failures) console.log(`FAIL  ${f.name}\n      ${f.msg}`);
  }
  console.log(`\n${pass}/${total} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
