// Shows whether the local gateway runs and has an allowance, and sets its address.

const DEFAULT_GATEWAY = "127.0.0.1:8484";
const statusEl = document.getElementById("status");
const input = document.getElementById("gateway");

function show(html, cls) {
  statusEl.className = cls;
  statusEl.innerHTML = html;
}

async function check(gateway) {
  try {
    const r = await fetch(`http://${gateway}/_allowance`);
    const j = await r.json();
    if (j.funded) {
      show("Running, with an allowance.", "ok");
    } else {
      show(
        `Running, no allowance yet. <a href="http://${gateway}/" target="_blank">Get one</a>.`,
        "warn",
      );
    }
  } catch {
    show("Not running. Start it with <code>decdn gateway</code>.", "err");
  }
}

chrome.storage.sync.get({ gateway: DEFAULT_GATEWAY }, ({ gateway }) => {
  input.value = gateway;
  check(gateway);
});

document.getElementById("save").addEventListener("click", () => {
  const gateway = input.value.trim() || DEFAULT_GATEWAY;
  chrome.storage.sync.set({ gateway }, () => check(gateway));
});
