# deCDN browser demo

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#license)

`decdn:` links in any web page, opened through your local `decdn gateway`. Write

```html
<img src="decdn:<hash>/path/to/image.png?ns=1">
<a href="decdn:<hash>/">a whole bundle</a>
```

and the browser shows the image and follows the link. The gateway fetches each file from
[deCDN](https://github.com/decdn/decdn) nodes, checks every byte against its BLAKE3 hash, pays
per megabyte under a capability a sponsor or a publisher issued, and streams the verified bytes
back.

The [Android](https://github.com/decdn/android-demo) and [iOS](https://github.com/decdn/ios-demo)
demos run the same SDK inside an app; this one puts it behind the browser.

## How it works

```text
┌──────────────── browser ────────────────┐
│ page: <img src="decdn:…">               │
│   content.js rewrites it to the gateway │
│   background.js labels the request:     │
│   x-decdn-token, x-decdn-host           │
└────────────────────┬────────────────────┘
                     │ HTTP, loopback only
┌────────────────────▼────────────────────┐      ┌─────────────┐
│ decdn gateway                           ├─────▶│ deCDN nodes │  iroh QUIC, paid per MB
│   pays with the capability whose scope  │      └─────────────┘
│   covers the page's host                │
└─────────────────────────────────────────┘
```

- **The gateway** is the `decdn gateway` command of the [`decdn` CLI](https://github.com/decdn/decdn).
  `GET /<hash>[/<path>][?ns=<id>]` serves `decdn:<hash>[/<path>][?ns=<id>]`: a file streams as
  it arrives, and a bundle (`/<hash>/`) gets a page listing its files. It holds one delegate key
  per capability, in memory only:
  - `GET /_delegate` mints a fresh key and returns its address. Every call returns a new
    address, so no site sees the same one twice and none can follow you across sites. A page
    calls it through CORS; the extension calls it with the gateway token. The pages of one site
    (subdomains included) hold at most a few keys, waiting or registered; the extension's own
    handshake is never limited.
  - `PUT /_capability` with `{"capability": "dcap1:…", "scope": "…"}` registers a capability
    issued to a minted address. Its owner signature must match the on-chain owner of its pool.
    A page registers through CORS, and its scope must cover its own host: `example.com` may
    register `example.com`, `*.example.com` or `*`, never another site, and never a wildcard
    over a public suffix such as `*.io` or `*.github.io`. The extension, with the
    gateway token, registers any scope.
  - A content request pays with the capability whose scope covers the page's host: an exact
    host first, then `*.<domain>`, then `*`.
- **The extension** ([`extension/`](extension/)) rewrites `decdn:` URLs in `href`, `src`,
  `poster` and `data` attributes to the gateway, including elements a page adds later, and
  labels the page's image, media and navigation requests to the gateway with the gateway token
  and the page's host. The browser adds those headers, so page scripts never see the token, and
  a page's own `fetch()` never carries it. The popup lists the gateway's capabilities and gets
  a sponsored one.
- Networking stays native. The gateway reaches nodes over direct QUIC like any `decdn` client,
  so the browser needs no WebTransport, WebRTC or relay.

The URI form is [`decdn:<hash>[/<path>][?ns=<id>]`](https://github.com/decdn/decdn/issues/2449):
the bare hash names a file, a trailing `/` a whole bundle, and a path one file inside it.

## Try it

1. Install the `decdn` CLI and start the gateway:

   ```bash
   decdn gateway
   ```

   It listens on `127.0.0.1:8484` and prints its token, which it keeps in
   `~/.decdn/gateway/token`. `decdn gateway` arrives with
   [decdn/decdn#2456](https://github.com/decdn/decdn/pull/2456); until a release includes it,
   build `decdn` from that branch with `cargo build --release -p decdn-cli`.
2. Load the extension. In Chrome or Brave, open `chrome://extensions`, turn on **Developer
   mode**, click **Load unpacked**, and pick the `extension/` folder. In Firefox, open
   `about:debugging#/runtime/this-firefox` and **Load Temporary Add-on** with
   `extension/manifest.json`.
3. Open the extension's popup, paste the gateway token under **Settings**, and click **Save**.
4. Click **Get a sponsored allowance** and pass the check on the page that opens. The extension
   registers the capability the testnet sponsor at `up.decdn.org` issues, for every site
   (`*`). Open the popup again to see it.
5. Open the demo page, [`demo/index.html`](demo/index.html), from any web server, for example:

   ```bash
   python3 -m http.server 8600
   ```

   then `http://127.0.0.1:8600/demo/`. It shows an image from the Stable Diffusion XL bundle,
   and links to a test file, the Sintel 4K bundle, and a file inside it.

A publisher funds its own pages the same way, without the popup: its page calls
`GET /_delegate`, its backend issues a capability to that address from its own pool, and the
page registers it with `PUT /_capability` and a scope covering its host.

## Scope

This is a demo. The gateway serves whole files in order and does not answer HTTP range
requests yet, so a video cannot seek. It serves one download at a time. Delegate keys live in
the gateway's memory, so a restart drops them and every capability issued to them; register
again after one. A site whose scope covers a page can spend that capability on any `decdn:`
content the page loads, up to the cap its issuer set.

## License

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option.
