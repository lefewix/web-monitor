async function getWatches() {
  return (await chrome.storage.local.get("watches")).watches || {};
}

function ago(ts) {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
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

    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.textContent = url.replace(/^https?:\/\//, "");
    a.onclick = () => clearChanged(url);

    const meta = document.createElement("span");
    meta.className = "meta" + (w.lastError ? " err" : "");
    meta.textContent = w.lastError ? "error" : ago(w.lastCheck);
    meta.title = w.lastError || (w.keyword ? `watching phrase: "${w.keyword}" (currently ${w.keywordPresent ? "present" : "absent"})` : "");
    if (w.keyword) meta.textContent = `“${w.keyword}” · ` + meta.textContent;

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

    li.append(a, meta, del);
    list.append(li);
  }
}

async function clearChanged(url) {
  const watches = await getWatches();
  if (watches[url]) watches[url].changed = false;
  await chrome.storage.local.set({ watches });
  chrome.runtime.sendMessage({ type: "updateBadge" });
  render();
}

document.getElementById("add").onsubmit = async e => {
  e.preventDefault();
  const url = document.getElementById("url").value.trim();
  const keyword = document.getElementById("keyword").value.trim().toLowerCase();
  const watches = await getWatches();
  watches[url] = keyword ? { keyword } : {};
  await chrome.storage.local.set({ watches });
  chrome.alarms.create(url, { periodInMinutes: 0.5 }); // 30s, Chrome's floor
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
chrome.storage.local.get("webhook").then(({ webhook }) => {
  if (webhook) document.getElementById("webhook").value = webhook;
});
document.getElementById("saveWebhook").onclick = async e => {
  e.preventDefault();
  await chrome.storage.local.set({ webhook: document.getElementById("webhook").value.trim() });
  e.target.textContent = "Saved ✓";
  setTimeout(() => (e.target.textContent = "Save"), 1200);
};

render();
renderHistory();
