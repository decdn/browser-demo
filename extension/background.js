// Labels requests to the gateway with the gateway token and the page's host.
//
// A page's content script reports its host; this adds a session rule that sets
// x-decdn-token and x-decdn-host on that page's image, media, frame and
// navigation requests to the gateway. The browser adds the headers, so page
// scripts never see the token, and a page's own fetch() or XHR never carries
// it. The gateway pays with the capability whose scope covers the host.

const DEFAULT_GATEWAY = "127.0.0.1:8484";
// The gateway is always on loopback: the token never leaves the machine.
const GATEWAY = /^(127\.0\.0\.1|localhost):\d{1,5}$/;
// Session rules are capped (5000 in Chrome); stay well under it.
const MAX_RULES = 1000;
const RESOURCE_TYPES = ["image", "media", "main_frame", "sub_frame", "object"];

// Only content paths (/<64-hex hash>...) get the token, never the gateway's
// own /_delegate or /_capability endpoints, and only on GET or HEAD.
function contentFilter(gateway) {
  const escaped = gateway.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^http://${escaped}/[0-9a-fA-F]{64}([/?#]|$)`;
}

// Runs storage read-modify-writes one at a time, so two callers never lose
// each other's update.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function settings() {
  const { gateway } = await chrome.storage.sync.get({ gateway: DEFAULT_GATEWAY });
  const { token } = await chrome.storage.local.get({ token: "" });
  return { gateway: GATEWAY.test(gateway) ? gateway : DEFAULT_GATEWAY, token };
}

// One rule id per page host, from a map in session storage: ids never
// collide, and the least recently labelled host is dropped past MAX_RULES.
// Returns [id, ids of evicted rules].
function ruleId(host) {
  return serial(async () => {
    const { rules = {}, nextId = 1 } = await chrome.storage.session.get(["rules", "nextId"]);
    const evicted = [];
    let id = rules[host]?.id;
    let next = nextId;
    if (!id) {
      id = next++;
      const hosts = Object.keys(rules).sort((a, b) => rules[a].used - rules[b].used);
      while (hosts.length >= MAX_RULES) {
        const old = hosts.shift();
        evicted.push(rules[old].id);
        delete rules[old];
      }
    }
    rules[host] = { id, used: Date.now() };
    await chrome.storage.session.set({ rules, nextId: next });
    return [id, evicted];
  });
}

async function label(host, origin) {
  const { gateway, token } = await settings();
  if (!token) return { gateway, labelled: false };
  // Content the gateway serves runs on the gateway's own origin; never label it.
  if (origin === `http://${gateway}`) return { gateway, labelled: false };
  const [id, evicted] = await ruleId(host);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id, ...evicted],
    addRules: [
      {
        id,
        // initiatorDomains also matches subdomains: the most specific host wins.
        priority: host.split(".").length,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "x-decdn-token", operation: "set", value: token },
            { header: "x-decdn-host", operation: "set", value: host },
          ],
        },
        condition: {
          regexFilter: contentFilter(gateway),
          initiatorDomains: [host],
          requestMethods: ["get", "head"],
          resourceTypes: RESOURCE_TYPES,
        },
      },
    ],
  });
  // The token or gateway changed while this rule went in: drop it again.
  const now = await settings();
  if (now.token !== token || now.gateway !== gateway) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
    return { gateway: now.gateway, labelled: false };
  }
  return { gateway, labelled: true };
}

// The onramp's handshake for a delegate the popup minted: wait for the
// capability the onramp issues once the person passes its check, then register
// it with the gateway for every site.
const ONRAMP = "https://up.decdn.org";
const SPONSOR_TIMEOUT_MS = 10 * 60 * 1000;

// The delegates waiting for a check live in session storage, so a worker that
// Chrome stops and restarts picks them up again.
async function pendingDelegates() {
  const { pending } = await chrome.storage.session.get({ pending: {} });
  return pending;
}

// Keeps an alarm running while a delegate waits: if the browser stops the
// worker anyway, the alarm wakes it and resume() picks the polling up again.
const HEARTBEAT = "sponsor-heartbeat";

function setPending(address, since) {
  return serial(async () => {
    const pending = await pendingDelegates();
    if (since) pending[address] = since;
    else delete pending[address];
    await chrome.storage.session.set({ pending });
    if (Object.keys(pending).length) await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 });
    else await chrome.alarms.clear(HEARTBEAT);
  });
}

// One look at the onramp for `address`: registers the capability when it is
// there. Returns true once the delegate needs no more polling.
async function claim(address) {
  const r = await fetch(`${ONRAMP}/v1/capability?client=${address}`);
  if (r.status !== 200) return false;
  const { token: capability } = await r.json();
  const { gateway, token } = await settings();
  const put = await fetch(`http://${gateway}/_capability`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-decdn-token": token },
    body: JSON.stringify({ capability, scope: "*" }),
  });
  // 409: already registered, or the gateway no longer holds the delegate.
  return put.ok || put.status === 409;
}

const polling = new Set();

async function poll(address) {
  if (polling.has(address)) return;
  polling.add(address);
  try {
    while (true) {
      const pending = await pendingDelegates();
      const since = pending[address];
      if (!since || Date.now() - since > SPONSOR_TIMEOUT_MS) break;
      try {
        if (await claim(address)) break;
      } catch {
        // The onramp or the gateway is briefly unreachable; keep polling.
      }
      // An extension API call resets Chrome's idle timer, so the worker is
      // not stopped while it waits for the person to pass the check.
      await chrome.runtime.getPlatformInfo();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    polling.delete(address);
    await setPending(address, null);
  }
}

async function resume() {
  for (const address of Object.keys(await pendingDelegates())) poll(address);
}

resume();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT) resume();
});

// Mint a delegate, record it as pending before anything can stop this worker,
// open the onramp's check for it, and poll until its capability is registered.
async function startSponsor() {
  const { gateway, token } = await settings();
  const r = await fetch(`http://${gateway}/_delegate`, { headers: { "x-decdn-token": token } });
  if (!r.ok) throw new Error(`the gateway answered ${r.status}`);
  const { address } = await r.json();
  await setPending(address, Date.now());
  poll(address);
  await chrome.tabs.create({ url: `${ONRAMP}/fund?client=${address}` });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message && message.type === "sponsor" && !sender.tab) {
    startSponsor().then(
      () => reply({}),
      (e) => reply({ error: e.message }),
    );
    return true;
  }
  if (message && message.type === "resume" && !sender.tab) {
    resume();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT) resume();
});
    return false;
  }
  if (message && message.type === "label" && sender.url) {
    let { hostname: host, origin } = new URL(sender.url);
    // about:blank and srcdoc frames load as their parent's origin.
    if (!host && /^about:/.test(sender.url) && typeof message.origin === "string") {
      try {
        ({ hostname: host, origin } = new URL(message.origin));
      } catch {
        host = "";
      }
    }
    if (host) {
      label(host, origin).then(reply, () => reply({ labelled: false }));
      return true;
    }
  }
  return false;
});

// A new token or gateway address makes every existing label stale. Pages
// re-label straight away, so keep the rules already made with the new values.
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.token || changes.gateway) {
    const { gateway, token } = await settings();
    const current = (r) =>
      r.condition.regexFilter === contentFilter(gateway) &&
      r.action.requestHeaders?.some((h) => h.header === "x-decdn-token" && h.value === token);
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.filter((r) => !current(r)).map((r) => r.id),
    });
  }
});
