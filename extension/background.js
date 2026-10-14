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

async function sponsor(address) {
  const deadline = Date.now() + SPONSOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ONRAMP}/v1/capability?client=${address}`);
      if (r.status === 200) {
        const { token: capability } = await r.json();
        const { gateway, token } = await settings();
        const put = await fetch(`http://${gateway}/_capability`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-decdn-token": token },
          body: JSON.stringify({ capability, scope: "*" }),
        });
        return put.ok;
      }
    } catch {
      // The onramp or the gateway is briefly unreachable; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message && message.type === "sponsor" && !sender.tab) {
    sponsor(message.address);
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
