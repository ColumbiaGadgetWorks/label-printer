"""Exercise the /api/print authorisation rules against a live server."""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJ = os.path.dirname(os.path.abspath(__file__))
PORT = 8123
BASE = "http://127.0.0.1:%d" % PORT
PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 64   # PNG magic + filler


def start(env_extra):
    env = dict(os.environ)
    env["PORT"] = str(PORT)
    env["WEB_ROOT"] = os.path.join(PROJ, "web")
    env.update(env_extra)
    p = subprocess.Popen([sys.executable, "-u", os.path.join(PROJ, "server.py")],
                         env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/healthz", timeout=1).read()
            return p
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def req(path, method="GET", headers=None, body=None):
    r = urllib.request.Request(BASE + path, method=method, data=body,
                               headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:80]}


def case(name, env, checks):
    p = start(env)
    try:
        print("\n=== %s ===" % name)
        for label, fn in checks:
            try:
                ok, detail = fn()
            except Exception as exc:
                ok, detail = False, "EXCEPTION %s" % exc
            print("  [%s] %s :: %s" % ("PASS" if ok else "FAIL", label, detail))
            if not ok:
                FAILURES.append("%s / %s" % (name, label))
    finally:
        p.terminate()
        p.wait(timeout=5)


FAILURES = []
CFG = {"CUPS_HOST": "192.168.1.50", "CUPS_PRINTER": "Zebra_Test"}

# 1. localhost explicitly allowed
case("allowed: peer inside PRINT_ALLOW_CIDRS",
     dict(CFG, PRINT_ALLOW_CIDRS="127.0.0.1/32,::1/128"),
     [("capabilities says directPrint", lambda: (
         (lambda s, j: (j["directPrint"] is True and j.get("printer") == "Zebra_Test",
                        json.dumps(j)))(*req("/api/capabilities")))),
      ("POST gets past auth to CUPS", lambda: (
          (lambda s, j: (s == 502 and j.get("error") == "cups-failed",
                         "HTTP %s %s" % (s, j.get("detail", "")[:60])))(
              *req("/api/print", "POST", {"Content-Type": "image/png"}, PNG))))])

# 2. peer outside the allowlist
OFF = dict(CFG, PRINT_ALLOW_CIDRS="192.168.99.0/24")
case("refused: peer outside PRINT_ALLOW_CIDRS", OFF,
     [("capabilities says off-network", lambda: (
         (lambda s, j: (j["directPrint"] is False and j["reason"] == "off-network",
                        json.dumps(j)))(*req("/api/capabilities")))),
      ("queue name not disclosed", lambda: (
          (lambda s, j: ("printer" not in j, json.dumps(j)))(*req("/api/capabilities")))),
      ("POST refused 403", lambda: (
          (lambda s, j: (s == 403 and j.get("error") == "off-network",
                         "HTTP %s %s" % (s, j))))(
              *req("/api/print", "POST", {"Content-Type": "image/png"}, PNG)))])

# 3. THE important one: spoofed forwarding headers must not help
case("refused: spoofed X-Forwarded-For / CF-Connecting-IP", OFF,
     [("XFF spoof rejected", lambda: (
         (lambda s, j: (s == 403, "HTTP %s %s" % (s, j)))(
             *req("/api/print", "POST",
                  {"Content-Type": "image/png", "X-Forwarded-For": "192.168.99.5"}, PNG)))),
      ("CF-Connecting-IP spoof rejected", lambda: (
          (lambda s, j: (s == 403, "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png", "CF-Connecting-IP": "192.168.99.5"}, PNG)))),
      ("chained XFF spoof rejected", lambda: (
          (lambda s, j: (s == 403, "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png",
                    "X-Forwarded-For": "1.2.3.4, 192.168.99.5"}, PNG))))])

# 4. opt-in proxy trust works when deliberately configured
case("opt-in: TRUSTED_PROXIES makes XFF authoritative",
     dict(OFF, TRUSTED_PROXIES="127.0.0.1/32"),
     [("XFF from trusted peer accepted", lambda: (
         (lambda s, j: (s == 502 and j.get("error") == "cups-failed",
                        "HTTP %s (reached CUPS = auth passed)" % s))(
             *req("/api/print", "POST",
                  {"Content-Type": "image/png", "X-Forwarded-For": "192.168.99.5"}, PNG)))),
      ("XFF outside allowlist still refused", lambda: (
          (lambda s, j: (s == 403, "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png", "X-Forwarded-For": "8.8.8.8"}, PNG))))])

# 5. token layer
case("token: required and enforced",
     dict(CFG, PRINT_ALLOW_CIDRS="127.0.0.1/32", PRINT_TOKEN="s3cret-token"),
     [("capabilities: button enabled, token flagged", lambda: (
         (lambda s, j: (j["tokenRequired"] is True and j["directPrint"] is True,
                        json.dumps(j)))(*req("/api/capabilities")))),
      ("no token at all refused", lambda: (
          (lambda s, j: (s == 403 and j.get("error") == "bad-token", "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST", {"Content-Type": "image/png"}, PNG)))),
      ("wrong token refused", lambda: (
          (lambda s, j: (s == 403 and j.get("error") == "bad-token", "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png", "X-Print-Token": "wrong"}, PNG)))),
      ("correct token passes auth", lambda: (
          (lambda s, j: (s == 502, "HTTP %s (reached CUPS = auth passed)" % s))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png", "X-Print-Token": "s3cret-token"}, PNG))))])

# 6. feature off entirely
case("disabled: no CUPS_HOST/PRINTER", {"CUPS_HOST": "", "CUPS_PRINTER": ""},
     [("capabilities reports not configured", lambda: (
         (lambda s, j: (j["configured"] is False and j["directPrint"] is False,
                        json.dumps(j)))(*req("/api/capabilities")))),
      ("POST refused 503", lambda: (
          (lambda s, j: (s == 503 and j.get("error") == "not-configured",
                         "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST", {"Content-Type": "image/png"}, PNG))))])

# 7. body validation
case("validation: non-PNG body rejected",
     dict(CFG, PRINT_ALLOW_CIDRS="127.0.0.1/32"),
     [("junk body rejected 415", lambda: (
         (lambda s, j: (s == 415 and j.get("error") == "expected-png", "HTTP %s %s" % (s, j)))(
             *req("/api/print", "POST", {"Content-Type": "image/png"}, b"not a png at all")))),
      ("empty body rejected 413", lambda: (
          (lambda s, j: (s == 413, "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST", {"Content-Type": "image/png"}, b""))))])

print("\n" + "=" * 60)

# 8. the default allowlist must be fail-closed: a Docker-bridge or LAN address
#    must NOT be admitted unless the operator opted it in explicitly.
case("default allowlist is fail-closed (no PRINT_ALLOW_CIDRS set)",
     dict(CFG, TRUSTED_PROXIES="127.0.0.1/32"),
     [("docker bridge 172.17.0.5 refused", lambda: (
         (lambda s, j: (s == 403 and j.get("error") == "off-network", "HTTP %s %s" % (s, j)))(
             *req("/api/print", "POST",
                  {"Content-Type": "image/png", "X-Forwarded-For": "172.17.0.5"}, PNG)))),
      ("LAN 192.168.1.20 refused until opted in", lambda: (
          (lambda s, j: (s == 403 and j.get("error") == "off-network", "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png", "X-Forwarded-For": "192.168.1.20"}, PNG)))),
      ("public address refused", lambda: (
          (lambda s, j: (s == 403, "HTTP %s %s" % (s, j)))(
              *req("/api/print", "POST",
                   {"Content-Type": "image/png", "X-Forwarded-For": "203.0.113.9"}, PNG))))])

print("=" * 60)

if FAILURES:
    print("FAILURES (%d):" % len(FAILURES))
    for f in FAILURES:
        print("  - " + f)
    sys.exit(1)
print("ALL CHECKS PASSED")
