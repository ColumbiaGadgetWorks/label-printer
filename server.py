#!/usr/bin/env python3
"""Label Printer backend.

Serves the static UI and, optionally, prints a rasterised label straight to a
CUPS server via `lp`.

Security model
--------------
The only thing a remote caller cannot forge is the TCP source address of their
own connection. So authorisation is decided on the socket peer address, and
`X-Forwarded-For` / `CF-Connecting-IP` are IGNORED unless TRUSTED_PROXIES is
explicitly configured. That default means a request arriving through Cloudflare
or any other reverse proxy is judged by the proxy's address, which will not be
in PRINT_ALLOW_CIDRS, so it is refused.

The button state in the UI is cosmetic. Every POST to /api/print is re-checked
here regardless of what the client believes it is allowed to do.
"""

import ipaddress
import json
import logging
import os
import shlex
import subprocess
import tempfile
import time
from collections import deque
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

LOG = logging.getLogger("labelprinter")


def _cidrs(raw):
    out = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            LOG.warning("ignoring invalid CIDR %r", part)
    return out


WEB_ROOT = os.environ.get("WEB_ROOT", "/app/web")
PORT = int(os.environ.get("PORT", "8080"))

CUPS_HOST = os.environ.get("CUPS_HOST", "").strip()
CUPS_PRINTER = os.environ.get("CUPS_PRINTER", "").strip()
CUPS_OPTIONS = os.environ.get("CUPS_OPTIONS", "-o media=Custom.4x6in -o scaling=100")
PRINT_DPI = int(os.environ.get("PRINT_DPI", "203"))

PRINT_TOKEN = os.environ.get("PRINT_TOKEN", "").strip()
# Fail closed. A permissive RFC1918 default would be actively dangerous behind
# a reverse proxy: the container then sees the PROXY's address on every request,
# and Docker bridge addresses live inside 172.16.0.0/12, so a default including
# that range would have admitted the entire internet. Opt your LAN in explicitly.
ALLOW_CIDRS = _cidrs(os.environ.get("PRINT_ALLOW_CIDRS", "127.0.0.1/32,::1/128"))
TRUSTED_PROXIES = _cidrs(os.environ.get("TRUSTED_PROXIES", ""))

MAX_BODY = int(os.environ.get("MAX_BODY_BYTES", str(8 * 1024 * 1024)))
RATE_LIMIT = int(os.environ.get("PRINT_RATE_LIMIT", "30"))   # jobs per minute, all clients
LP_TIMEOUT = int(os.environ.get("LP_TIMEOUT", "25"))

CONFIGURED = bool(CUPS_HOST and CUPS_PRINTER)
_recent = deque(maxlen=200)


def _norm(ip):
    """Collapse IPv4-mapped IPv6 (::ffff:192.168.1.5) down to plain IPv4."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr


def _in(addr, nets):
    return any(addr in n for n in nets)


def client_addr(handler):
    """Resolve the caller's address.

    Proxy headers are consulted ONLY when the immediate peer is a configured
    trusted proxy. With TRUSTED_PROXIES empty (the default) this always returns
    the raw socket peer, which cannot be spoofed.
    """
    peer = _norm(handler.client_address[0])
    if peer is None or not TRUSTED_PROXIES or not _in(peer, TRUSTED_PROXIES):
        return peer

    cf = handler.headers.get("CF-Connecting-IP")
    if cf:
        return _norm(cf.strip()) or peer

    xff = handler.headers.get("X-Forwarded-For", "")
    # Walk right-to-left; the first address that is not itself a trusted proxy
    # is the closest thing to a real client that we can still believe.
    for candidate in reversed([p.strip() for p in xff.split(",") if p.strip()]):
        addr = _norm(candidate)
        if addr is None:
            continue
        if not _in(addr, TRUSTED_PROXIES):
            return addr
    return peer


_warned_proxy = [False]


def warn_if_proxied(handler):
    """A forwarding header with TRUSTED_PROXIES unset means this instance is
    almost certainly behind a reverse proxy whose address is what ALLOW_CIDRS
    is actually being compared against. Say so once, loudly."""
    if TRUSTED_PROXIES or _warned_proxy[0]:
        return
    if handler.headers.get("X-Forwarded-For") or handler.headers.get("CF-Connecting-IP"):
        _warned_proxy[0] = True
        LOG.warning(
            "request carried a forwarding header but TRUSTED_PROXIES is empty. "
            "This instance looks proxied, so every caller is being judged as %s. "
            "Either run a separate un-proxied instance for printing, or set "
            "TRUSTED_PROXIES to the proxy address.", handler.client_address[0])


def network_ok(handler):
    """Position check only, no token. This is what decides the button state:
    a token cannot be supplied on the capabilities GET, so folding it in here
    would disable the button and leave no way to ever enter one."""
    if not CONFIGURED:
        return False, "not-configured"

    warn_if_proxied(handler)
    addr = client_addr(handler)
    if addr is None:
        return False, "no-address"
    if not _in(addr, ALLOW_CIDRS):
        return False, "off-network"
    return True, "ok"


def authorise(handler):
    """Full check for an actual print. Return (ok, reason)."""
    ok, reason = network_ok(handler)
    if not ok:
        return False, reason

    if PRINT_TOKEN:
        supplied = handler.headers.get("X-Print-Token", "")
        # constant-time-ish compare; both are short strings
        if len(supplied) != len(PRINT_TOKEN) or not all(
            a == b for a, b in zip(supplied, PRINT_TOKEN)
        ):
            return False, "bad-token"

    return True, "ok"


def rate_ok():
    now = time.time()
    while _recent and now - _recent[0] > 60:
        _recent.popleft()
    if len(_recent) >= RATE_LIMIT:
        return False
    _recent.append(now)
    return True


def send_to_cups(png_bytes, copies, title):
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            fh.write(png_bytes)
            path = fh.name

        cmd = ["lp", "-h", CUPS_HOST, "-d", CUPS_PRINTER,
               "-n", str(copies), "-t", title]
        cmd += shlex.split(CUPS_OPTIONS)
        cmd.append(path)

        LOG.info("lp: %s", " ".join(shlex.quote(c) for c in cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=LP_TIMEOUT)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()[:400]
            return False, detail or "lp exited %d" % proc.returncode
        return True, (proc.stdout or "").strip()
    except FileNotFoundError:
        return False, "lp not found in container"
    except subprocess.TimeoutExpired:
        return False, "lp timed out after %ds (is CUPS_HOST reachable?)" % LP_TIMEOUT
    except Exception as exc:                      # noqa: BLE001 - surfaced to caller
        return False, "%s: %s" % (type(exc).__name__, exc)
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


class Handler(SimpleHTTPRequestHandler):
    server_version = "labelprinter"

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "3")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return

        if self.path.split("?")[0] == "/api/capabilities":
            ok, reason = network_ok(self)
            payload = {
                "directPrint": ok,
                "configured": CONFIGURED,
                "reason": reason,
                "dpi": PRINT_DPI,
                "tokenRequired": bool(PRINT_TOKEN),
            }
            # Only disclose the queue name to a caller already cleared to use it.
            if ok:
                payload["printer"] = CUPS_PRINTER
                payload["seenAs"] = str(client_addr(self))
            elif reason == "off-network":
                LOG.info("capabilities: direct print withheld, caller seen as %s",
                         client_addr(self))
            self._json(200, payload)
            return

        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/print":
            self.send_error(404)
            return

        ok, reason = authorise(self)
        if not ok:
            LOG.warning("print refused (%s) from %s", reason, self.client_address[0])
            code = 503 if reason == "not-configured" else 403
            self._json(code, {"ok": False, "error": reason})
            return

        if not rate_ok():
            self._json(429, {"ok": False, "error": "rate-limited"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"ok": False, "error": "bad-body-size"})
            return

        body = self.rfile.read(length)
        if not body.startswith(b"\x89PNG\r\n\x1a\n"):
            self._json(415, {"ok": False, "error": "expected-png"})
            return

        try:
            copies = max(1, min(20, int(self.headers.get("X-Copies", "1"))))
        except ValueError:
            copies = 1

        LOG.info("print accepted from %s (%d bytes, %d copies)",
                 self.client_address[0], len(body), copies)
        sent, detail = send_to_cups(body, copies, "label")
        if sent:
            self._json(200, {"ok": True, "detail": detail})
        else:
            LOG.error("cups error: %s", detail)
            self._json(502, {"ok": False, "error": "cups-failed", "detail": detail})

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.client_address[0], fmt % args)


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    LOG.info("serving %s on :%d", WEB_ROOT, PORT)
    if CONFIGURED:
        LOG.info("direct print -> %s @ %s (%d dpi)", CUPS_PRINTER, CUPS_HOST, PRINT_DPI)
        LOG.info("allowed from: %s", ", ".join(str(n) for n in ALLOW_CIDRS) or "(none)")
        LOG.info("token required: %s", "yes" if PRINT_TOKEN else "no")
        if TRUSTED_PROXIES:
            LOG.warning("TRUSTED_PROXIES set (%s): forwarded headers WILL be trusted "
                        "from those addresses", ", ".join(str(n) for n in TRUSTED_PROXIES))
    else:
        LOG.info("direct print disabled (set CUPS_HOST and CUPS_PRINTER to enable)")

    handler = partial(Handler, directory=WEB_ROOT)
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer(("", PORT), handler).serve_forever()


if __name__ == "__main__":
    main()
