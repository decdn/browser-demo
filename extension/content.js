// Rewrites decdn: URLs in the page to the local decdn gateway.
//
// decdn:<hash>[/<path>][?ns=<id>] becomes http://<gateway>/<hash>[/<path>][?ns=<id>],
// on links and on media sources, including elements the page adds later. The
// gateway fetches the content from deCDN, checks every byte against the hash,
// and streams it back.

const DEFAULT_GATEWAY = "127.0.0.1:8484";
const SCHEME = "decdn:";
const ATTRIBUTES = ["href", "src", "poster", "data"];
const SELECTOR = ATTRIBUTES.map((a) => `[${a}^="${SCHEME}" i]`).join(",");

function rewrite(root, gateway) {
  const nodes = root.querySelectorAll ? [...root.querySelectorAll(SELECTOR)] : [];
  if (root.matches && root.matches(SELECTOR)) nodes.push(root);
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

chrome.storage.sync.get({ gateway: DEFAULT_GATEWAY }, ({ gateway }) => {
  rewrite(document, gateway);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") rewrite(m.target, gateway);
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) rewrite(node, gateway);
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
});
