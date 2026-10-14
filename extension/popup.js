// Connects to the gateway, lists its capabilities, and gets a sponsored one.
//
// The sponsored allowance is the onramp's handshake, which the background
// worker runs rather than the gateway: get a fresh delegate address from the
// gateway, pass the onramp's check for it in a new tab, poll the onramp for
// the capability it issues, and register that capability for every site.

const DEFAULT_GATEWAY = "127.0.0.1:8484";
const $ = (id) => document.getElementById(id);

function show(html, cls) {
  $("status").className = cls;
  $("status").innerHTML = html;
}

async function settings() {
  const { gateway } = await chrome.storage.sync.get({ gateway: DEFAULT_GATEWAY });
  const { token } = await chrome.storage.local.get({ token: "" });
  return { gateway, token };
}

function describe(c) {
  const usdc = (c.cap / 1e6).toFixed(2);
  const until = new Date(c.expiry * 1000).toLocaleString();
  const by = c.origin ? ` from ${c.origin}` : "";
  const spent = c.spent ? " (spent)" : "";
  return `<code>${c.scope}</code>: up to ${usdc} USDC until ${until}${by}${spent}`;
}

async function refresh() {
  const { gateway, token } = await settings();
  $("gateway").value = gateway;
  $("token").value = token;
  const list = $("capabilities");
  list.innerHTML = "";
  if (!token) {
    show("Paste the gateway token under Settings.", "warn");
    return;
  }
  try {
    const r = await fetch(`http://${gateway}/_capability`, { headers: { "x-decdn-token": token } });
    if (r.status === 401) return show("The gateway token does not match.", "err");
    const capabilities = await r.json();
    const live = capabilities.filter((c) => !c.spent);
    const { pending } = await chrome.storage.session.get({ pending: {} });
    const waiting = Object.keys(pending).length;
    if (waiting) {
      // Wakes the background worker if Chrome stopped it mid-wait.
      chrome.runtime.sendMessage({ type: "resume" });
      setTimeout(refresh, 2000);
    }
    if (live.length) show("Running.", "ok");
    else if (waiting) show("Waiting for the onramp check to finish…", "warn");
    else show("Running, with no capability yet.", "warn");
    for (const c of capabilities) {
      const li = document.createElement("li");
      li.innerHTML = describe(c);
      list.append(li);
    }
  } catch {
    show("Not running. Start it with <code>decdn gateway</code>.", "err");
  }
}

// The background worker runs the whole handshake: opening the onramp tab
// closes this popup, and anything still running here would stop with it.
async function sponsor() {
  const { token } = await settings();
  if (!token) return show("Paste the gateway token under Settings first.", "warn");
  const reply = await chrome.runtime.sendMessage({ type: "sponsor" });
  if (reply && reply.error) show(`Could not start: ${reply.error}`, "err");
}

$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({ gateway: $("gateway").value.trim() || DEFAULT_GATEWAY });
  await chrome.storage.local.set({ token: $("token").value.trim() });
  refresh();
});
$("sponsor").addEventListener("click", sponsor);
refresh();
