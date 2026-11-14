// Rewrites decdn: URLs in the page to the local decdn gateway.
//
// decdn:<hash>[/<path>][?ns=<id>] becomes http://<gateway>/<hash>[/<path>][?ns=<id>]
// in href, src, poster, data, srcset, imagesrcset and SVG xlink:href, including
// elements the page adds or changes later and those inside open shadow roots.
// Only URLs that start with a 64-hex hash are rewritten; any other decdn: value
// is left alone. On the first decdn: URL it finds, the script asks the
// background worker to label this page's requests to the gateway, and rewrites
// only once the label is in place, so no request reaches the gateway without
// it. A new token or gateway puts the original URLs back and labels again.

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

// Every element under `root` that matches `selector`, including those inside
// open shadow roots, which are observed from here on too.
function deepQuery(root, selector) {
  const nodes = root.querySelectorAll ? [...root.querySelectorAll(selector)] : [];
  if (root.matches && root.matches(selector)) nodes.push(root);
  const hosts = root.querySelectorAll ? [...root.querySelectorAll("*")] : [];
  if (root.shadowRoot) hosts.push(root);
  for (const host of hosts) {
    if (!host.shadowRoot) continue;
    observe(host.shadowRoot);
    nodes.push(...deepQuery(host.shadowRoot, selector));
  }
  return nodes;
}

const matches = (root) => deepQuery(root, SELECTOR);

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

// Whether a changed attribute is one this script rewrites.
function watched(m) {
  if (m.attributeNamespace === XLINK) return m.attributeName === "href";
  return !m.attributeNamespace && PLAIN.some(([name]) => name === m.attributeName);
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "attributes" && watched(m)) rewrite(m.target);
    for (const node of m.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) rewrite(node);
    }
  }
});

// Roots already observed; weak, so removed shadow roots can be collected.
const observed = new WeakSet();

function observe(root) {
  if (observed.has(root)) return;
  observed.add(root);
  // No attributeFilter: it never matches a namespaced attribute such as
  // xlink:href, so watched() filters instead.
  observer.observe(root, { subtree: true, childList: true, attributes: true });
}

// Runs at document_start: the observer sees every element the parser adds,
// before a person can click a decdn: link the browser cannot open.
observe(document);
rewrite(document);

// The data-decdn-* attribute holding each rewritten attribute's original value.
const dataAttr = (attr) => `data-${original(attr).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
const RESTORE = ALL.map((attr) => `[${dataAttr(attr)}]`).join(",");

// A new token or gateway drops every label: put the decdn: URLs back, then
// rewrite the whole page again, so a page that loaded before the token was set
// gets rewritten too.
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.token && !changes.gateway) return;
  labelled = null;
  for (const el of deepQuery(document, RESTORE)) {
    for (const attr of ALL) {
      const key = original(attr);
      if (!(key in el.dataset)) continue;
      set(el, attr, el.dataset[key]);
      delete el.dataset[key];
    }
  }
  rewrite(document);
});
