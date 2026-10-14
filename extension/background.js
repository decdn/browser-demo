// Labels requests to the gateway with the gateway token and the page's host.
//
// A page's content script reports its host; this adds a session rule that sets
// x-decdn-token and x-decdn-host on that page's image, media, frame and
// navigation requests to the gateway. The browser adds the headers, so page
// scripts never see the token, and a page's own fetch() or XHR never carries
// it. The gateway pays with the capability whose scope covers the host.

const DEFAULT_GATEWAY = "127.0.0.1:8484";
const RESOURCE_TYPES = ["image", "media", "main_frame", "sub_frame", "object", "other"];

// A stable rule id per page host (DNR ids are positive 31-bit integers).
function ruleId(host) {
  let h = 0;
  for (const c of host) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return (h & 0x7fffffff) || 1;
}

async function settings() {
  const { gateway } = await chrome.storage.sync.get({ gateway: DEFAULT_GATEWAY });
  const { token } = await chrome.storage.local.get({ token: "" });
  return { gateway, token };
}

async function label(host) {
  const { gateway, token } = await settings();
  if (!token) return { gateway, labelled: false };
  const id = ruleId(host);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "x-decdn-token", operation: "set", value: token },
            { header: "x-decdn-host", operation: "set", value: host },
          ],
        },
        condition: {
          urlFilter: `|http://${gateway}/`,
          initiatorDomains: [host],
          resourceTypes: RESOURCE_TYPES,
        },
      },
    ],
  });
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

async function setPending(address, since) {
  const pending = await pendingDelegates();
  if (since) pending[address] = since;
  else delete pending[address];
  await chrome.storage.session.set({ pending });
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
    return false;
  }
  if (message && message.type === "label" && sender.url) {
    const host = new URL(sender.url).hostname;
    if (host) {
      label(host).then(reply, () => reply({ labelled: false }));
      return true;
    }
  }
  return false;
});

// A new token or gateway address makes every existing label stale.
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.token || changes.gateway) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((r) => r.id),
    });
  }
});
