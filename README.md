# deCDN browser demo

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#license)

`decdn:` links in any web page, opened through your local `decdn gateway`. Write

```html
<img src="decdn:<hash>/path/to/image.png?ns=1">
<a href="decdn:<hash>/">a whole bundle</a>
```

and the browser shows the image and follows the link. The gateway fetches each file from
[deCDN](https://github.com/decdn/decdn) nodes, checks every byte against its BLAKE3 hash, pays
per megabyte from a sponsored allowance, and streams the verified bytes back.

The [Android](https://github.com/decdn/android-demo) and [iOS](https://github.com/decdn/ios-demo)
demos run the same SDK inside an app; this one puts it behind the browser.

## How it works

```text
┌──────────── browser ────────────┐
│ page: <img src="decdn:…">       │
│   content.js rewrites it to     │
│   http://127.0.0.1:8484/…       │
└───────────────┬─────────────────┘
                │ HTTP, loopback only
┌───────────────▼─────────────────┐      ┌─────────────┐
│ decdn gateway                   ├─────▶│ deCDN nodes │  iroh QUIC, paid per MB
│   decdn fetch, streamed         │      └─────────────┘
│   throwaway key + allowance ────┼─────▶ up.decdn.org onramp
└─────────────────────────────────┘
```

- **The extension** ([`extension/`](extension/)) is a content script and a popup. The script
  rewrites `decdn:` URLs in `href`, `src`, `poster` and `data` attributes to the gateway,
  including elements a page adds later. The popup shows whether the gateway runs and has an
  allowance, and sets its address.
- **The gateway** is the `decdn gateway` command of the
  [`decdn` CLI](https://github.com/decdn/decdn). `GET /<hash>[/<path>][?ns=<id>]` serves
  `decdn:<hash>[/<path>][?ns=<id>]`: a file streams as it arrives, and a bundle (`/<hash>/`)
  gets a page listing its files. `http://127.0.0.1:8484/` shows the allowance.
- Networking stays native. The gateway reaches nodes over direct QUIC like any `decdn` client,
  so the browser needs no WebTransport, WebRTC or relay.

The URI form is [`decdn:<hash>[/<path>][?ns=<id>]`](https://github.com/decdn/decdn/issues/2449):
the bare hash names a file, a trailing `/` a whole bundle, and a path one file inside it.

## Try it

1. Install the `decdn` CLI and start the gateway:

   ```bash
   decdn gateway
   ```

   It listens on `127.0.0.1:8484` and keeps its throwaway key under `~/.decdn/gateway`.
   `decdn gateway` arrives with [decdn/decdn#2456](https://github.com/decdn/decdn/pull/2456);
   until a release includes it, build `decdn` from that branch with
   `cargo build --release -p decdn-cli`.
2. Load the extension. In Chrome or Brave, open `chrome://extensions`, turn on **Developer
   mode**, click **Load unpacked**, and pick the `extension/` folder. In Firefox, open
   `about:debugging#/runtime/this-firefox` and **Load Temporary Add-on** with
   `extension/manifest.json`.
3. Open `http://127.0.0.1:8484/`, click **Get an allowance**, and pass the check on the page
   that opens. The gateway page updates by itself when the allowance arrives.
4. Open the demo page, [`demo/index.html`](demo/index.html), from any web server, for example:

   ```bash
   python3 -m http.server 8600
   ```

   then `http://127.0.0.1:8600/demo/`. It shows an image from the Stable Diffusion XL bundle,
   and links to a test file, the Sintel 4K bundle, and a file inside it.

Chrome may ask whether a public site may reach your local network the first time it loads from
the gateway; allow it for sites whose `decdn:` content you want to see.

## Scope

This is a demo. The gateway serves whole files in order and does not answer HTTP range
requests yet, so a video cannot seek. It serves one download at a time. It answers only on loopback and checks the `Host`
header, but any page the browser loads can request gateway URLs and spend the allowance; a
per-install token that only the extension knows is the planned guard. The allowance comes from
the testnet sponsor at `up.decdn.org`.

## License

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option.
