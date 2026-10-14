// Rewrites decdn: URLs in the page to the local decdn gateway.
//
// decdn:<hash>[/<path>][?ns=<id>] becomes http://<gateway>/<hash>[/<path>][?ns=<id>],
// on links and on media sources, including elements the page adds later. On
// the first decdn: URL it finds, the script asks the background worker to
// label this page's requests to the gateway, and rewrites only once the label
// is in place, so no request reaches the gateway without it.

const SCHEME = "decdn:";
const ATTRIBUTES = ["href", "src", "poster", "data"];
const SELECTOR = ATTRIBUTES.map((a) => `[${a}^="${SCHEME}" i]`).join(",");

let labelled = null;

function label() {
  if (!labelled) {
    labelled = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "label" }, (reply) => {
        resolve(reply && reply.labelled ? reply.gateway : null);
      });
    });
  }
  return labelled;
}

function matches(root) {
  const nodes = root.querySelectorAll ? [...root.querySelectorAll(SELECTOR)] : [];
  if (root.matches && root.matches(SELECTOR)) nodes.push(root);
  return nodes;
}

async function rewrite(root) {
  const nodes = matches(root);
  if (nodes.length === 0) return;
  const gateway = await label();
  if (!gateway) return;
  for (const el of nodes) {
    for (const attr of ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value && value.slice(0, SCHEME.length).toLowerCase() === SCHEME) {
        el.setAttribute(attr, `http://${gateway}/${value.slice(SCHEME.length)}`);
        el.dataset.decdn = value;
      }
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
  attributeFilter: ATTRIBUTES,
});
