// Connects to the gateway, lists its capabilities, and gets a sponsored one.
//
// The sponsored allowance is the onramp's handshake, which the background
// worker runs rather than the gateway: get a fresh delegate address from the
// gateway, pass the onramp's check for it in a new tab, poll the onramp for
// the capability it issues, and register that capability for every site.

const DEFAULT_GATEWAY = "127.0.0.1:8484";
// The gateway is always on loopback: the token never leaves the machine.
const GATEWAY = /^(127\.0\.0\.1|localhost):\d{1,5}$/;
const $ = (id) => document.getElementById(id);

// Shows a status line. Parts are strings, or [text] for a <code> span; all
// text goes in as text, never as HTML.
function show(cls, ...parts) {
  const status = $("status");
  status.className = cls;
  status.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === "string") return p;
      const code = document.createElement("code");
      code.textContent = p[0];
      return code;
    }),
  );
}

// `rejected` is a saved gateway that is not on loopback, replaced by the default.
async function settings() {
  const { gateway } = await chrome.storage.sync.get({ gateway: DEFAULT_GATEWAY });
  const { token } = await chrome.storage.local.get({ token: "" });
  if (GATEWAY.test(gateway)) return { gateway, token };
  return { gateway: DEFAULT_GATEWAY, token, rejected: gateway };
}

function describe(c) {
  const li = document.createElement("li");
  const scope = document.createElement("code");
  scope.textContent = String(c.scope);
  const usdc = (Number(c.cap) / 1e6).toFixed(2);
  const until = new Date(Number(c.expiry) * 1000).toLocaleString();
  const by = c.origin ? ` from ${c.origin}` : "";
  const spent = c.spent ? " (spent)" : "";
  li.append(scope, `: up to ${usdc} USDC until ${until}${by}${spent}`);
  return li;
}

// One pending refresh at a time, however often refresh() is called: a newer
// call makes an older one that is still waiting drop its result.
let timer = null;
let generation = 0;

async function refresh() {
  clearTimeout(timer);
  timer = null;
  const run = ++generation;
  const stale = () => run !== generation;
  const { gateway, token, rejected } = await settings();
  $("gateway").value = gateway;
  $("token").value = token;
  const list = $("capabilities");
  list.replaceChildren();
  if (rejected) {
    return show("err", "The saved gateway ", [rejected], " is not on loopback; using ", [gateway], ". Click Save to keep it.");
  }
  if (!token) return show("warn", "Paste the gateway token under Settings.");
  // Firefox lets a person revoke host access; without it nothing reaches the gateway.
  if (!(await chrome.permissions.contains({ origins: [`http://${gateway}/*`] }))) {
    return show("err", "No access to ", [gateway], ". Click Save under Settings to allow it.");
  }
  let capabilities;
  try {
    const r = await fetch(`http://${gateway}/_capability`, { headers: { "x-decdn-token": token } });
    if (r.status === 401) return show("err", "The gateway token does not match.");
    if (stale()) return;
    if (!r.ok) return show("err", `The gateway answered ${r.status}.`);
    try {
      capabilities = await r.json();
    } catch {
      return show("err", "The gateway's answer is not JSON. Is something else on ", [gateway], "?");
    }
  } catch {
    if (stale()) return;
    return show("err", "Not running. Start it with ", ["decdn gateway"], ".");
  }
  if (!Array.isArray(capabilities)) {
    return show("err", "The gateway's answer is not a list of capabilities.");
  }
  const live = capabilities.filter((c) => !c.spent);
  const { pending, failed } = await chrome.storage.session.get({ pending: {}, failed: null });
  if (stale()) return;
  const waiting = Object.keys(pending).length;
  if (waiting) {
    // Wakes the background worker if the browser stopped it mid-wait.
    chrome.runtime.sendMessage({ type: "resume" }).catch(() => {});
    timer = setTimeout(refresh, 2000);
  }
  if (failed && !waiting) show("err", `The sponsored allowance failed: ${failed.error}.`);
  else if (live.length) show("ok", "Running.");
  else if (waiting) show("warn", "Waiting for the onramp check to finish…");
  else show("warn", "Running, with no capability yet.");
  list.append(...capabilities.map(describe));
}

// The background worker runs the whole handshake: opening the onramp tab
// closes this popup, and anything still running here would stop with it.
async function sponsor() {
  const button = $("sponsor");
  button.disabled = true;
  try {
    const { token } = await settings();
    if (!token) return show("warn", "Paste the gateway token under Settings first.");
    const reply = await chrome.runtime.sendMessage({ type: "sponsor" });
    if (reply && reply.error) show("err", `Could not start: ${reply.error}`);
  } catch (e) {
    show("err", `Could not start: ${e.message}`);
  } finally {
    button.disabled = false;
  }
}

$("save").addEventListener("click", async () => {
  const gateway = $("gateway").value.trim() || DEFAULT_GATEWAY;
  if (!GATEWAY.test(gateway)) {
    return show("err", "The gateway must be ", ["127.0.0.1:<port>"], " or ", ["localhost:<port>"], ".");
  }
  // Ask for host access first, while the click still counts as a gesture, but
  // save before waiting for the answer: Firefox can close this popup for the
  // prompt, and nothing after the await would run. refresh() reports missing
  // access, so a refused prompt still shows up the next time the popup opens.
  const asked = chrome.permissions.request({ origins: [`http://${gateway}/*`] });
  await chrome.storage.sync.set({ gateway });
  await chrome.storage.local.set({ token: $("token").value.trim() });
  const granted = await asked.catch(() => false);
  if (!granted) return show("err", "Without access to ", [gateway], " the extension cannot reach it.");
  refresh();
});
$("sponsor").addEventListener("click", sponsor);
refresh();
