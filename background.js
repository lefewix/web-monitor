// Service worker: wakes on each alarm, fetches the page, compares hash, notifies.

async function getWatches() {
  return (await chrome.storage.local.get("watches")).watches || {};
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function check(url) {
  const watches = await getWatches();
  const w = watches[url];
  if (!w) return; // watch was removed; stale alarm

  let body;
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (web-monitor)" } });
    body = await res.text();
  } catch (e) {
    w.lastError = e.message;
    w.lastCheck = Date.now();
    await chrome.storage.local.set({ watches });
    return;
  }

  // strip scripts/styles/tags/whitespace so markup churn doesn't false-alarm
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, "")
                   .replace(/<style[\s\S]*?<\/style>/gi, "")
                   .replace(/<[^>]+>/g, " ")
                   .replace(/\s+/g, " ")
                   .trim();
  const h = await sha256(text);

  if (w.keyword) {
    // keyword mode: alert only when the keyword appears/disappears (e.g. "sold out" gone = restock)
    const present = text.toLowerCase().includes(w.keyword);
    if (w.keywordPresent !== undefined && present !== w.keywordPresent) {
      w.changed = true;
      await alert(url, `Product status changed — "${w.keyword}" ${present ? "reappeared" : "gone"}`, watches);
    }
    w.keywordPresent = present;
  } else if (w.lastHash && w.lastHash !== h) {
    w.changed = true;
    await alert(url, "Page changed", watches);
  }
  w.lastHash = h;
  w.lastError = null;
  w.lastCheck = Date.now();
  await chrome.storage.local.set({ watches });
}

async function alert(url, title, watches) {
  chrome.notifications.create(url, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message: url,
  });
  updateBadge(watches);
  // append to alert history, newest first, capped at 50
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift({ ts: Date.now(), url, title });
  await chrome.storage.local.set({ history: history.slice(0, 50) });

  // optional webhook ping (ntfy.sh, discord, ifttt → email, anything that takes a POST)
  const { webhook } = await chrome.storage.local.get("webhook");
  if (webhook) {
    const msg = `${title}\n${url}`;
    try {
      if (webhook.includes("discord.com/api/webhooks")) {
        await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: msg }) });
      } else {
        await fetch(webhook, { method: "POST", body: msg });
      }
    } catch (e) {
      console.warn("webhook failed:", e.message);
    }
  }
}

function updateBadge(watches) {
  const n = Object.values(watches).filter(w => w.changed).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#FC7643" });
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
  return true; // keep sendResponse alive for async
});

// recreate alarms after browser restart / extension update
async function syncAlarms() {
  const watches = await getWatches();
  for (const url of Object.keys(watches)) {
    chrome.alarms.create(url, { periodInMinutes: 0.5 }); // 30s, Chrome's floor
  }
  updateBadge(watches);
}
chrome.runtime.onStartup.addListener(syncAlarms);
chrome.runtime.onInstalled.addListener(syncAlarms);
