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
  ...ATTRIBUTES.map((a) => `[*|${a}^="${SCHEME}" i]`),
  ...SRCSETS.map((a) => `[${a}*="${SCHEME}" i]`),
].join(",");
// The rewritten path must start with a 64-hex hash, so a decdn: URL can never
// reach the gateway's own endpoints (decdn:_delegate, decdn:<hash>/../_x).
const CONTENT_PATH = /^\/[0-9a-f]{64}(\/|$)/i;

let labelled = null;

function label() {
  if (!labelled) {
    labelled = new Promise((resolve) => {
      // about:blank and srcdoc frames have no host of their own; their
      // requests go out as the parent's origin, which location.origin gives.
      chrome.runtime.sendMessage({ type: "label", origin: location.origin }, (reply) => {
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

const XLINK = "http://www.w3.org/1999/xlink";

// Each rewritable attribute: [name, namespace]. SVG's legacy xlink:href is
// namespaced; everything else is a plain attribute.
const PLAIN = [...ATTRIBUTES, ...SRCSETS].map((a) => [a, null]);
const ALL = [...PLAIN, ["href", XLINK]];

const get = (el, [name, ns]) => (ns ? el.getAttributeNS(ns, name) : el.getAttribute(name));
const set = (el, [name, ns], value) =>
  ns ? el.setAttributeNS(ns, `xlink:${name}`, value) : el.setAttribute(name, value);
// The original decdn: value of each rewritten attribute, kept for re-labelling:
// data-decdn-src, data-decdn-srcset, data-decdn-xlink-href, ...
const original = ([name, ns]) => `decdn${ns ? "XlinkH" + name.slice(1) : name[0].toUpperCase() + name.slice(1)}`;

// Open shadow roots are scanned and observed too.
const roots = new Set();

function matches(root) {
  const nodes = root.querySelectorAll ? [...root.querySelectorAll(SELECTOR)] : [];
  if (root.matches && root.matches(SELECTOR)) nodes.push(root);
  const hosts = root.querySelectorAll ? [...root.querySelectorAll("*")] : [];
  if (root.shadowRoot) hosts.push(root);
  for (const host of hosts) {
    if (!host.shadowRoot) continue;
    observe(host.shadowRoot);
    nodes.push(...matches(host.shadowRoot));
  }
  return nodes;
}

async function rewrite(root) {
  const nodes = matches(root);
  if (nodes.length === 0) return;
  const gateway = await label();
  if (!gateway) return;
  for (const el of nodes) {
    let source = false;
    for (const attr of ALL) {
      const value = get(el, attr);
      if (!value) continue;
      const srcset = SRCSETS.includes(attr[0]) && !attr[1];
      let to = null;
      if (srcset && value.toLowerCase().includes(SCHEME)) {
        to = rewriteSrcset(value, gateway);
        if (to === value) to = null;
      } else if (!srcset && isDecdn(value)) {
        to = toGateway(value, gateway);
      }
      if (!to) continue;
      el.dataset[original(attr)] = value;
      set(el, attr, to);
      source = true;
    }
    // A media element does not re-run source selection when a <source> child
    // changes; it already gave up on the decdn: URL.
    if (source && el.localName === "source" && el.parentElement instanceof HTMLMediaElement) {
      el.parentElement.load();
    }
  }
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "attributes") rewrite(m.target);
    for (const node of m.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) rewrite(node);
    }
  }
});

function observe(root) {
  if (roots.has(root)) return;
  roots.add(root);
  // attributeFilter takes local names, so "href" also covers xlink:href.
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES, ...SRCSETS],
  });
}

// Runs at document_start: the observer sees every element the parser adds,
// before a person can click a decdn: link the browser cannot open.
observe(document);
rewrite(document);

// A new token or gateway drops every label: put the decdn: URLs back, so the
// observer labels the page again and rewrites them to the current gateway.
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.token && !changes.gateway) return;
  labelled = null;
  for (const root of roots) {
    for (const attr of ALL) {
      const key = original(attr);
      const data = `data-${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
      for (const el of root.querySelectorAll(`[${data}]`)) {
        set(el, attr, el.dataset[key]);
        delete el.dataset[key];
      }
    }
  }
});
