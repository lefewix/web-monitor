async function getWatches() {
  return (await chrome.storage.local.get("watches")).watches || {};
}

// Re-read, touch one entry, write back — background.js may be mid-check.
async function updateWatch(url, mutate) {
  const watches = await getWatches();
  if (!watches[url]) return;
  mutate(watches[url]);
  await chrome.storage.local.set({ watches });
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
      const watches = await getWatches();
      delete watches[url];
      await chrome.storage.local.set({ watches });
      chrome.alarms.clear(url);
      chrome.runtime.sendMessage({ type: "updateBadge" });
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

    const snoozed = w.snoozeUntil > Date.now();
    if (snoozed) {
      chips.append(chip(`muted ${until(w.snoozeUntil)}`, "muted", "notifications suppressed; still checking"));
      const un = document.createElement("button");
      un.className = "tiny";
      un.textContent = "unmute";
      un.onclick = async () => { await updateWatch(url, x => { x.snoozeUntil = 0; }); render(); };
      chips.append(un);
    } else if (w.changed) {
      chips.append(chip("snooze", "label", "suppress notifications for a while"));
      for (const h of [1, 6, 24]) {
        const b = document.createElement("button");
        b.className = "tiny";
        b.textContent = `${h}h`;
        b.onclick = async () => {
          await updateWatch(url, x => { x.snoozeUntil = Date.now() + h * 3600000; });
          render();
        };
        chips.append(b);
      }
    }

    li.append(line, chips);
    list.append(li);
  }
}

async function clearChanged(url) {
  await updateWatch(url, w => { w.changed = false; });
  chrome.runtime.sendMessage({ type: "updateBadge" });
  render();
}

document.getElementById("add").onsubmit = async e => {
  e.preventDefault();
  const url = document.getElementById("url").value.trim();
  const keyword = document.getElementById("keyword").value.trim().toLowerCase();
  const selector = document.getElementById("selector").value.trim();
  const interval = Number(document.getElementById("interval").value) || 0.5;
  const watches = await getWatches();
  watches[url] = { interval };
  if (keyword) watches[url].keyword = keyword;
  if (selector) watches[url].selector = selector;
  await chrome.storage.local.set({ watches });
  chrome.alarms.create(url, { periodInMinutes: interval });
  chrome.runtime.sendMessage({ type: "checkNow", url }, render); // baseline fetch now
  document.getElementById("add").reset();
  render();
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
  await chrome.storage.local.set({ history: [] });
  renderHistory();
};

// prefill with the tab you're on
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const t = tabs[0];
  const urlInput = document.getElementById("url");
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
  await chrome.storage.local.set({ webhook: document.getElementById("webhook").value.trim(), webhookStatus: null });
  showStatus("", true);
  e.target.textContent = "Saved";
  setTimeout(() => (e.target.textContent = "Save"), 1200);
};

document.getElementById("testWebhook").onclick = async e => {
  e.preventDefault();
  const webhook = document.getElementById("webhook").value.trim();
  if (!webhook) return showStatus("enter a webhook URL first", false);
  showStatus("sending…", true);
  chrome.runtime.sendMessage({ type: "testWebhook", webhook }, r => {
    if (!r) return showStatus("no response from the extension", false);
    showStatus(r.ok ? `delivered — ${r.detail}` : `failed — ${r.detail}`, r.ok);
  });
};

render();
renderHistory();
