// The popup NEVER writes `watches` or `history` — the service worker is the
// single writer. Reads are direct; every mutation is a message it applies inside
// its serialised queue.

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(r || { ok: false, error: "no response from the extension" });
    });
  });
}

async function getWatches() {
  return (await chrome.storage.local.get("watches")).watches || {};
}

// Minutes-only ages read as "42000m ago" on a watch that died last week, which is
// exactly the case the user most needs to understand at a glance.
function ago(ts) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function until(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  return m >= 60 ? `${Math.round(m / 60)}h` : `${Math.max(m, 1)}m`;
}

const INTERVAL_LABELS = { 0.5: "30s", 1: "1m", 5: "5m", 15: "15m", 60: "1h" };

function chip(text, cls, title) {
  const s = document.createElement("span");
  s.className = "meta" + (cls ? " " + cls : "");
  s.textContent = text;
  if (title) s.title = title;
  return s;
}

function tinyButton(label, title, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tiny";
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
}

const addForm = document.getElementById("add");
const urlInput = document.getElementById("url");
const keywordInput = document.getElementById("keyword");
const selectorInput = document.getElementById("selector");
const intervalInput = document.getElementById("interval");
const addError = document.getElementById("addError");
const searchInput = document.getElementById("search");
const searchRow = document.getElementById("searchRow");

function showAddError(text) {
  addError.textContent = text || "";
  addError.className = "status" + (text ? " err" : "");
}

// Re-adding a URL is the edit path — the worker preserves its baseline and
// snooze state, so "edit" just refills the form.
function editWatch(url, w) {
  urlInput.value = url;
  keywordInput.value = w.keyword || "";
  selectorInput.value = w.selector || "";
  intervalInput.value = String(w.interval || 0.5);
  showAddError("");
  urlInput.focus();
}

// Changed rows first, then broken ones, then alphabetically — at twenty watches
// the two rows you actually need must not be somewhere in the middle.
function rank(w) {
  if (w.changed) return 0;
  if (w.dead || w.alertFailure) return 1;
  return 2;
}

function matches(url, w, q) {
  if (!q) return true;
  return (url + " " + (w.keyword || "") + " " + (w.selector || "")).toLowerCase().includes(q);
}

// which rows have their snooze durations expanded
const openSnooze = new Set();

async function render() {
  const watches = await getWatches();
  const list = document.getElementById("list");
  const entries = Object.entries(watches);
  searchRow.hidden = entries.length <= 5;
  const q = searchRow.hidden ? "" : searchInput.value.trim().toLowerCase();

  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = '<div class="empty">nothing watched yet — add a URL above</div>';
    return;
  }
  const rows = entries
    .filter(([url, w]) => matches(url, w, q))
    .sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  if (!rows.length) {
    list.innerHTML = '<div class="empty">no watch matches that</div>';
    return;
  }

  for (const [url, w] of rows) {
    const li = document.createElement("li");
    li.className = [w.changed ? "changed" : "", (w.dead || w.alertFailure) ? "broken" : ""].filter(Boolean).join(" ");

    const line = document.createElement("div");
    line.className = "line";

    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.textContent = url.replace(/^https?:\/\//, "");
    a.title = url;
    a.onclick = () => clearChanged(url);

    const now = tinyButton("check", "check this page right now", async e => {
      e.target.disabled = true;
      e.target.textContent = "checking…";
      await send({ type: "checkNow", url });
      render();
      renderHistory();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "✕";
    del.title = "stop watching";
    del.onclick = async () => {
      const r = await send({ type: "remove", url });
      render();
      if (r.watch) {
        undoToast(`Stopped watching ${url.replace(/^https?:\/\//, "")}`, async () => {
          await send({ type: "restoreWatch", url: r.url || url, watch: r.watch });
          render();
        });
      }
    };

    line.append(a, now, del);

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.append(chip(INTERVAL_LABELS[w.interval] || "30s", "", "check interval"));

    if (w.keyword) {
      // Three states. `undefined` used to render as "absent", which on a
      // "sold out" watch reads as in stock before the first check has even run.
      const state = w.keywordPresent === undefined ? "not checked yet" : (w.keywordPresent ? "present" : "absent");
      const cls = w.keywordPresent === undefined ? "unknown" : "";
      chips.append(chip(`“${w.keyword}” ${state}`, cls, `watching this phrase — currently ${state}`));
    }
    if (w.selector) chips.append(chip(w.selector, "", "only this element is watched"));

    // Error AND age, never one or the other: a watch broken for three days used
    // to look exactly like one that blipped thirty seconds ago.
    if (w.lastError) {
      chips.append(chip(w.lastError, "err", w.lastError));
      chips.append(chip(`last good ${ago(w.lastSuccess)}`, w.lastSuccess ? "" : "err", "last check that actually saw the page"));
    } else {
      chips.append(chip(`checked ${ago(w.lastCheck)}`, "", "last check attempt"));
      if (w.lastSuccess && w.lastCheck && Math.abs(w.lastSuccess - w.lastCheck) > 60000) {
        chips.append(chip(`last good ${ago(w.lastSuccess)}`, "", "last check that actually saw the page"));
      }
    }

    if (w.throttled) {
      chips.append(chip(`+${w.throttled} more`, "", "further changes within the alert cooldown — counted, not notified"));
    }

    if (w.alertFailure) {
      const f = w.alertFailure;
      chips.append(chip("alert not delivered", "err", `${f.title}\n${f.detail || ""}\n${new Date(f.ts).toLocaleString()}`));
      chips.append(tinyButton("dismiss", "acknowledge the undelivered alert", async () => {
        await send({ type: "dismissAlertFailure", url });
        render();
      }));
    }

    chips.append(tinyButton("edit", "change interval, phrase or selector", () => editWatch(url, w)));

    const snoozed = w.snoozeUntil > Date.now();
    if (snoozed) {
      chips.append(chip(`muted ${until(w.snoozeUntil)}`, "muted", "notifications suppressed; still checking"));
      chips.append(tinyButton("unmute", "resume notifications", async () => {
        await send({ type: "snooze", url, until: 0 });
        render();
      }));
    } else if (openSnooze.has(url)) {
      // Mute is available on every row: you shouldn't have to wait for a watch
      // to shout at you before you can tell it to be quiet.
      chips.append(chip("mute for", "label"));
      for (const h of [1, 6, 24]) {
        chips.append(tinyButton(`${h}h`, `mute for ${h}h`, async () => {
          openSnooze.delete(url);
          await send({ type: "snooze", url, until: Date.now() + h * 3600000 });
          render();
        }));
      }
    } else {
      chips.append(tinyButton("mute", "suppress notifications for a while", () => {
        openSnooze.add(url);
        render();
      }));
    }

    li.append(line, chips);
    list.append(li);
  }
}

async function clearChanged(url) {
  await send({ type: "clearChanged", url });
  render();
}

searchInput.oninput = () => render();

addForm.onsubmit = async e => {
  e.preventDefault();
  showAddError("");
  const url = urlInput.value.trim();
  const r = await send({
    type: "add",
    url,
    keyword: keywordInput.value.trim().toLowerCase(),
    selector: selectorInput.value.trim(),
    interval: Number(intervalInput.value) || 0.5,
  });
  if (!r.ok) return showAddError(r.error || "could not save that watch");
  addForm.reset();
  await render();
  await send({ type: "checkNow", url: r.url || url }); // baseline fetch now
  render();
  renderHistory();
};

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  const ul = document.getElementById("history");
  ul.innerHTML = "";
  if (!history.length) {
    ul.innerHTML = '<div class="empty">no alerts yet</div>';
    return;
  }
  for (const ev of history) {
    const li = document.createElement("li");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(ev.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const a = document.createElement("a");
    a.href = ev.url;
    a.target = "_blank";
    a.textContent = `${ev.title} — ${ev.url.replace(/^https?:\/\//, "")}`;
    li.append(when, a);
    if (ev.preview) {
      const p = document.createElement("div");
      p.className = "preview";
      p.textContent = ev.preview;
      p.title = ev.preview;
      li.append(p);
    }
    ul.append(li);
  }
}

document.getElementById("clearHistory").onclick = async e => {
  e.preventDefault(); // don't toggle the <details>
  const r = await send({ type: "clearHistory" });
  renderHistory();
  if (r.rows && r.rows.length) {
    undoToast(`Cleared ${r.rows.length} alert${r.rows.length === 1 ? "" : "s"}`, async () => {
      await send({ type: "restoreHistory", rows: r.rows });
      renderHistory();
    });
  }
};

// ------------------------------------------------------------------ undo toast
// Destructive actions are undoable rather than confirmed: one toast at a time,
// it restores exactly what was removed, and its timer does not run while it is
// hovered or focused — otherwise a keyboard user can lose the undo mid-reach.

const toastRoot = document.getElementById("toasts");
let toastEl = null, toastTimer = 0;

function undoToast(text, onUndo) {
  dismissToast();

  const t = toastEl = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");

  const label = document.createElement("span");
  label.className = "toast-t";
  label.textContent = text;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "undo";
  btn.textContent = "Undo";
  btn.onclick = async () => {
    dismissToast();
    await onUndo();
  };

  t.append(label, btn);
  toastRoot.append(t);
  btn.focus();

  const start = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => dismissToast(t), 6000); };
  const hold = () => clearTimeout(toastTimer);
  t.addEventListener("mouseenter", hold);
  t.addEventListener("focusin", hold);
  t.addEventListener("mouseleave", () => { if (!t.contains(document.activeElement)) start(); });
  t.addEventListener("focusout", () => { if (!t.matches(":hover")) start(); });
  start();
}

function dismissToast(t) {
  if (t && t !== toastEl) return;
  clearTimeout(toastTimer);
  if (toastEl) toastEl.remove();
  toastEl = null;
}

// prefill with the tab you're on
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const t = tabs[0];
  if (t && t.url && t.url.startsWith("http") && !urlInput.value) urlInput.value = t.url;
});

// webhook setting
const statusEl = document.getElementById("webhookStatus");

function showStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = "status" + (text ? (ok ? " ok" : " err") : "");
}

chrome.storage.local.get(["webhook", "webhookStatus"]).then(({ webhook, webhookStatus }) => {
  if (webhook) document.getElementById("webhook").value = webhook;
  if (webhookStatus && !webhookStatus.ok) {
    showStatus(`last delivery failed: ${webhookStatus.detail} (${ago(webhookStatus.ts)})`, false);
  }
});

document.getElementById("saveWebhook").onclick = async e => {
  e.preventDefault();
  await send({ type: "setWebhook", webhook: document.getElementById("webhook").value.trim() });
  showStatus("", true);
  e.target.textContent = "Saved";
  setTimeout(() => (e.target.textContent = "Save"), 1200);
};

document.getElementById("testWebhook").onclick = async e => {
  e.preventDefault();
  const webhook = document.getElementById("webhook").value.trim();
  if (!webhook) return showStatus("enter a webhook URL first", false);
  showStatus("sending…", true);
  const r = await send({ type: "testWebhook", webhook });
  showStatus(r.ok ? `delivered — ${r.detail}` : `failed — ${r.error || r.detail}`, r.ok);
};

// A check landing while the popup is open used to leave it showing stale state
// until you closed and reopened it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.watches) render();
  if (changes.history) renderHistory();
});

render();
renderHistory();
