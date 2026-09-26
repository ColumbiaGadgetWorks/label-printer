# Label Printer

A tiny self-hosted web app for printing 4×6″ labels on a Zebra (or any ZPL-compatible)
thermal printer. Type text, hit print, done. Works from a desktop or a phone.

Two layouts:

| Mode | What comes out |
|---|---|
| **4×6 single** | One full 4×6″ label |
| **3 × 2×4 + cut marks** | One 4×6″ label divided into three 4×2″ sections, with 4 small tick marks (left and right edge at the 2″ and 4″ lines) showing where to cut |

Controls: text entry, font (5 choices), alignment, **bold / underline / CAPS / wrap**,
auto-fit text sizing or a manual size slider, and edge padding. Settings persist in
the browser.

Two ways to print:

| | How it works | Where it works |
|---|---|---|
| **Print** | Renders an exact 4×6″ page and opens the browser's own print dialog | Anywhere, including over the internet. Needs the Zebra driver on the device you are holding. |
| **Direct print** | Rasterises the label to a 4×6″ PNG at the printer's native dpi and posts it to the server, which submits it to CUPS with `lp` | Only from addresses you explicitly allow. Hidden entirely when not configured. |

---

## Security model

This is the part worth reading before you expose it at `labels.comogadget.casa`.

**Wi-Fi SSID cannot be detected.** No browser exposes the network name to a web
page. There is no API for it. So "are they on hackerwifi" is not a question the
app can ask; network address is the closest honest substitute.

**The button state is cosmetic.** Whatever the UI decides, anyone can open
devtools, re-enable the button, or skip the page entirely and `curl` the endpoint.
So every `POST /api/print` is re-checked server-side and the UI is treated as
untrusted.

**Authorisation uses the TCP peer address, not headers.** `X-Forwarded-For` and
`CF-Connecting-IP` are strings the caller controls. By default this app ignores
them completely and judges only the real socket address, which cannot be forged.
`TRUSTED_PROXIES` opts specific addresses into being believed, and nothing else.

**`PRINT_ALLOW_CIDRS` fails closed.** The default is loopback only. There is
deliberately no permissive RFC1918 default, because behind a reverse proxy the
container sees the *proxy's* address on every request, and Docker bridge
addresses sit inside `172.16.0.0/12`. A default covering that range would have
admitted the entire internet the moment you put NPM in front of it.

### The deployment that makes this simple

Run two instances of the same image. The split is the actual boundary:

```
internet -> Cloudflare -> NPM -> label-printer-public   (no CUPS_HOST at all)
LAN client ------------------->  label-printer-lan      (CUPS_HOST set, never proxied)
```

The public instance has no printer configured, so there is no code path from the
internet to the Zebra. Not a blocked one. None. It cannot be misconfigured into
existence by a bad header or a wrong CIDR, and `/api/print` answers 503 no matter
who asks. The Direct print button does not render there at all.

The LAN instance is never proxied, never port-forwarded, and never given a public
DNS name. It sees real LAN source addresses, so the allowlist means what it says.

That is why `docker-compose.yml` defines two services.

### Why not one instance behind NPM?

You can, but you have to understand what you are doing. Behind a proxy the
container sees NPM's address for every request, so `PRINT_ALLOW_CIDRS` alone
cannot tell a LAN visitor from a remote one. You would need to:

1. Set `TRUSTED_PROXIES` to NPM's address as the container sees it.
2. Set `PRINT_ALLOW_CIDRS` to your LAN subnet only, never the Docker bridge range.
3. Accept that you are now trusting NPM to set `X-Forwarded-For` honestly.

The app handles this correctly if you do (it walks `X-Forwarded-For` right to
left and takes the first address that is not itself a trusted proxy, which is
always whoever actually connected to your outermost proxy). But there is a trap:
**if a LAN device visits `labels.comogadget.casa`, the traffic goes out to
Cloudflare and comes back**, so it arrives looking like a Cloudflare address and
is correctly refused. To get a single URL that behaves differently on-LAN you
need split-horizon DNS, which you can do with a DNS rewrite in AdGuard Home
pointing `labels.comogadget.casa` at NPM's LAN address so LAN traffic never
leaves the network.

Two instances avoid all of this. Start there.

### If "on the wifi" is not tight enough

Set `PRINT_TOKEN`. The app then asks for it once and remembers it per browser.
This stacks on top of the network check rather than replacing it. Use it if
guests or IoT devices share the subnet.

---

## Quick start

```bash
docker compose up -d
```

Edit `CUPS_HOST`, `CUPS_PRINTER` and `PRINT_ALLOW_CIDRS` in `docker-compose.yml`
first. Then:

- public UI: `http://<host>:8088` (browser printing only)
- LAN UI: `http://<host>:8089` (browser printing plus Direct print)

Point NPM at **8088**, never 8089.

Static-only fallback with no backend at all, if you want to drop direct printing:

```bash
docker compose -f docker-compose.nobuild.yml up -d
```

The Direct print button hides itself automatically when `/api` is absent.

---

## Unraid

With the Compose Manager plugin, drop this folder in
`/mnt/user/appdata/label-printer/` and point a stack at `docker-compose.yml`.

For the Docker tab, add two containers from the same built image, differing only
in port and environment, mirroring the compose file above. The public one gets no
`CUPS_*` variables.

Bridge networking preserves the real client address for LAN clients, which is what
the allowlist depends on. If every caller is refused, check
`docker logs label-printer-lan`: refusals log the address the server actually saw.

---

## CUPS on the Raspberry Pi

CUPS listens on localhost only by default, so the container cannot reach it until
you change that. In `/etc/cups/cupsd.conf`:

```
Listen 0.0.0.0:631

<Location />
  Order allow,deny
  Allow from 192.168.1.*
</Location>
```

Then `sudo systemctl restart cups`. Confirm the queue name with `lpstat -p`; that
exact name goes in `CUPS_PRINTER`.

Anything that can reach port 631 can now print, so keep it on the LAN.

---

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `CUPS_HOST` | CUPS server address, optionally `host:port`. Unset disables direct print entirely. | empty |
| `CUPS_PRINTER` | Queue name from `lpstat -p`. Unset disables direct print entirely. | empty |
| `PRINT_ALLOW_CIDRS` | Comma-separated CIDRs permitted to print, matched against the real peer address. | `127.0.0.1/32,::1/128` |
| `PRINT_TOKEN` | Optional shared secret, required in addition to the network check. | empty |
| `TRUSTED_PROXIES` | CIDRs whose `X-Forwarded-For` / `CF-Connecting-IP` will be believed. Leave empty unless proxied. | empty |
| `CUPS_OPTIONS` | Passed through to `lp`. | `-o media=Custom.4x6in -o scaling=100` |
| `PRINT_DPI` | Raster resolution. 203 for ZD410/GK420d, 300 for 300dpi models. | `203` |
| `PRINT_RATE_LIMIT` | Jobs per minute across all clients. | `30` |
| `LP_TIMEOUT` | Seconds to wait for `lp`. | `25` |
| `PORT` | Listen port inside the container. | `8080` |

---

## Printer setup for browser printing

The Zebra driver must be installed on the device you are printing from, not on
the server.

1. Set the driver page size to `4.00 x 6.00 in`. If this is wrong, everything
   else will be wrong too.
2. In the print dialog: Paper `4 x 6`, Margins **None**, Scale **100%** (not
   "Fit to page"), headers and footers off.
3. Print one and measure it. A few percent small means Scale is not at 100%.

Chrome and Edge remember these per printer. Safari works but check the scale.
iOS and Android print via AirPrint/Mopria, talking to the printer directly.

---

## How the cut marks work

In 3-up mode the 6″ height is split into three exact 2″ bands. The marks are 4
short black ticks, 0.18″ long, flush to the left and right edges at the 2″ and 4″
lines. Line up a blade on opposing pairs and cut straight across. The dashed lines
on screen are editing guides and are never printed.

---

## Files

```
server.py                     static serving + /api/capabilities + /api/print
test_auth.py                  authorisation test suite (see below)
Dockerfile                    python:alpine + cups-client
docker-compose.yml            the two-instance deployment
docker-compose.nobuild.yml    nginx, static only, no direct print
nginx.conf                    used only by the nobuild variant
web/index.html                the UI
web/style.css                 styling, and the @media print rules that matter
web/app.js                    auto-fit, rasteriser, state persistence
```

Two parts are worth understanding:

`fitCell` in `web/app.js` binary-searches the font size until the text fits its
cell, reading only layout metrics (`scrollHeight` / `clientWidth`), which are
immune to the preview's CSS scale transform. Words are never broken mid-word: a
word too wide for the line overflows, which is what lets the fitter notice and
shrink. Each word is its own nowrap span, so lines break only at spaces and
`BIN A-12` never splits across the hyphen.

`rasterize` redraws the label onto a canvas at printer dpi using positions read
back out of the live DOM, so what gets sent is by construction the layout the
preview showed, rather than a second implementation that can drift.

---

## Testing the security rules

```bash
python test_auth.py
```

Starts the server under a range of configurations and asserts the behaviour,
including that spoofed `X-Forwarded-For` and `CF-Connecting-IP` headers are
refused, that the queue name is not disclosed to unauthorised callers, and that
the default allowlist admits neither a LAN nor a Docker-bridge address until you
opt it in. 21 checks, no dependencies.

---

## Troubleshooting

**Direct print button is missing.** That instance has no `CUPS_HOST` /
`CUPS_PRINTER`. Expected on the public one.

**Direct print is greyed out.** Your address is not in `PRINT_ALLOW_CIDRS`.
`docker logs` shows the address the server actually saw, which is the fastest way
to spot that you are arriving via a proxy.

**Logs warn about a forwarding header with `TRUSTED_PROXIES` empty.** The instance
is behind a proxy and every caller is being judged as that proxy. Either use the
two-instance layout or configure `TRUSTED_PROXIES`.

**`lp not found in container`.** You are running the nginx variant, or the image
was built without `cups-client`.

**`lp` times out.** CUPS is not reachable from the container. Check `Listen` in
`cupsd.conf` and that port 631 is open to the Docker host.

**Label prints on two pages.** Margins are not None, or Scale is not 100%. The
page box has zero slack at 4×6.

**Direct print output is the wrong size.** Tune `CUPS_OPTIONS`, and check
`PRINT_DPI` matches your printer (203 vs 300).

**Text is clipped at the edge.** Switch Edge padding to *Roomy*.

---

## Known limits

- The Docker image has not been built or run; there is no Docker on the machine
  this was developed on. The `Dockerfile` is a COPY into `python:3.12-alpine`
  plus `apk add cups-client`.
- Direct printing has never been exercised against a real CUPS server or a real
  Zebra. The authorisation layer is tested; the `lp` invocation and the
  `CUPS_OPTIONS` defaults are informed guesses, which is why they are env-tunable.
- Raster output is anti-aliased greyscale and left for CUPS to halftone. If text
  looks muddy on a thermal head, thresholding to pure black and white in
  `rasterize` is the knob to reach for.
