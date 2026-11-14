// Rewrites decdn: URLs in the page to the local decdn gateway.
//
// decdn:<hash>[/<path>][?ns=<id>] becomes http://<gateway>/<hash>[/<path>][?ns=<id>],
// on links and on media sources, including elements the page adds later. On
// the first decdn: URL it finds, the script asks the background worker to
// label this page's requests to the gateway, and rewrites only once the label
// is in place, so no request reaches the gateway without it.

const SCHEME = "decdn:";
const ATTRIBUTES = ["href", "src", "poster", "data"];
const SRCSETS = ["srcset", "imagesrcset"];
const SELECTOR = [
  ...ATTRIBUTES.map((a) => `[${a}^="${SCHEME}" i]`),
  ...SRCSETS.map((a) => `[${a}*="${SCHEME}" i]`),
].join(",");
// The rewritten path must start with a 64-hex hash, so a decdn: URL can never
// reach the gateway's own endpoints (decdn:_delegate, decdn:<hash>/../_x).
const CONTENT_PATH = /^\/[0-9a-f]{64}(\/|$)/i;

let labelled = null;

function label() {
  if (!labelled) {
    labelled = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "label" }, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply && reply.labelled ? reply.gateway : null);
      });
    });
    // Ask again next time rather than caching a failure (no token yet).
    labelled.then((gateway) => {
      if (!gateway) labelled = null;
    });
  }
  return labelled;
}

function isDecdn(url) {
  return url.slice(0, SCHEME.length).toLowerCase() === SCHEME;
}

// The gateway URL for a decdn: URL, or null when it is not a content path.
function toGateway(url, gateway) {
  try {
    const u = new URL(`http://${gateway}/${url.slice(SCHEME.length)}`);
    return u.host === gateway && CONTENT_PATH.test(u.pathname) ? u.href : null;
  } catch {
    return null;
  }
}

function rewriteSrcset(value, gateway) {
  return value
    .split(",")
    .map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      const to = url && isDecdn(url) ? toGateway(url, gateway) : null;
      return to ? [to, ...descriptor].join(" ") : candidate.trim();
    })
    .join(", ");
}

function matches(root) {
  const nodes = root.querySelectorAll ? [...root.querySelectorAll(SELECTOR)] : [];
  if (root.matches && root.matches(SELECTOR)) nodes.push(root);
  return nodes;
}

// The original decdn: value of each rewritten attribute, kept for re-labelling.
const original = (attr) => `decdn${attr[0].toUpperCase()}${attr.slice(1)}`;

async function rewrite(root) {
  const nodes = matches(root);
  if (nodes.length === 0) return;
  const gateway = await label();
  if (!gateway) return;
  for (const el of nodes) {
    let source = false;
    for (const attr of ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (!value || !isDecdn(value)) continue;
      const to = toGateway(value, gateway);
      if (!to) continue;
      el.dataset[original(attr)] = value;
      el.setAttribute(attr, to);
      source = true;
    }
    for (const attr of SRCSETS) {
      const value = el.getAttribute(attr);
      if (!value || !value.toLowerCase().includes(SCHEME)) continue;
      const to = rewriteSrcset(value, gateway);
      if (to === value) continue;
      el.dataset[original(attr)] = value;
      el.setAttribute(attr, to);
      source = true;
    }
    // A media element does not re-run source selection when a <source> child
    // changes; it already gave up on the decdn: URL.
    if (source && el.localName === "source" && el.parentElement instanceof HTMLMediaElement) {
      el.parentElement.load();
    }
  }
}

rewrite(document);
new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "attributes") rewrite(m.target);
    for (const node of m.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) rewrite(node);
    }
  }
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: [...ATTRIBUTES, ...SRCSETS],
});

// A new token or gateway drops every label: put the decdn: URLs back, so the
// observer labels the page again and rewrites them to the current gateway.
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.token && !changes.gateway) return;
  labelled = null;
  for (const attr of [...ATTRIBUTES, ...SRCSETS]) {
    const key = original(attr);
    const data = `data-decdn-${attr}`;
    for (const el of document.querySelectorAll(`[${data}]`)) {
      el.setAttribute(attr, el.dataset[key]);
      delete el.dataset[key];
    }
  }
});
