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

function ago(ts) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
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

async function render() {
  const watches = await getWatches();
  const list = document.getElementById("list");
  list.innerHTML = "";
  if (!Object.keys(watches).length) {
    list.innerHTML = '<div class="empty">nothing watched yet — add a URL above</div>';
    return;
  }
  for (const [url, w] of Object.entries(watches)) {
    const li = document.createElement("li");
    if (w.changed) li.className = "changed";

    const line = document.createElement("div");
    line.className = "line";

    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.textContent = url.replace(/^https?:\/\//, "");
    a.title = url;
    a.onclick = () => clearChanged(url);

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "✕";
    del.title = "stop watching";
    del.onclick = async () => {
      await send({ type: "remove", url });
      render();
    };

    line.append(a, del);

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.append(chip(INTERVAL_LABELS[w.interval] || "30s", "", "check interval"));
    if (w.keyword) chips.append(chip(`“${w.keyword}”`, "", `watching phrase (currently ${w.keywordPresent ? "present" : "absent"})`));
    if (w.selector) chips.append(chip(w.selector, "", "only this element is watched"));
    if (w.lastError) chips.append(chip(w.lastError, "err", w.lastError));
    else chips.append(chip(ago(w.lastCheck), "", "last checked"));

    chips.append(tinyButton("edit", "change interval, phrase or selector", () => editWatch(url, w)));

    const snoozed = w.snoozeUntil > Date.now();
    if (snoozed) {
      chips.append(chip(`muted ${until(w.snoozeUntil)}`, "muted", "notifications suppressed; still checking"));
      chips.append(tinyButton("unmute", "resume notifications", async () => {
        await send({ type: "snooze", url, until: 0 });
        render();
      }));
    } else if (w.changed) {
      chips.append(chip("snooze", "label", "suppress notifications for a while"));
      for (const h of [1, 6, 24]) {
        chips.append(tinyButton(`${h}h`, `mute for ${h}h`, async () => {
          await send({ type: "snooze", url, until: Date.now() + h * 3600000 });
          render();
        }));
      }
    }

    li.append(line, chips);
    list.append(li);
  }
}

async function clearChanged(url) {
  await send({ type: "clearChanged", url });
  render();
}

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
  await send({ type: "checkNow", url }); // baseline fetch now
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
  await send({ type: "clearHistory" });
  renderHistory();
};

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

render();
renderHistory();
