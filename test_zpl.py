"""Check the bitmap -> ZPL path: the compressed ^GFA data must decode back to
the exact bitmap, and /api/print-bitmap must hand CUPS raw ZPL.

Uses a fake `lp` on PATH that records its arguments and the job file, so no
CUPS server or printer is needed."""
import json
import os
import random
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PROJ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJ)
import server  # noqa: E402

PORT = 8124
BASE = "http://127.0.0.1:%d" % PORT
FAILURES = []


def start(env_extra):
    env = dict(os.environ, PORT=str(PORT), WEB_ROOT=os.path.join(PROJ, "web"))
    env.update(env_extra)
    p = subprocess.Popen([sys.executable, "-u", os.path.join(PROJ, "server.py")],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/healthz", timeout=1).read()
            return p
        except Exception:                          # noqa: BLE001
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def check(label, ok, detail=""):
    print("  [%s] %s %s" % ("PASS" if ok else "FAIL", label, detail))
    if not ok:
        FAILURES.append(label)


def decode_gfa(data, stride, height):
    """Independent decoder for ZPL compressed ASCII hex, per the ZPL manual."""
    rows, cur, count, prev = [], "", 0, None
    width = stride * 2

    def flush():
        nonlocal cur, prev
        rows.append(cur)
        prev, cur = cur, ""

    for ch in data:
        if "G" <= ch <= "Y":
            count += ord(ch) - ord("G") + 1
        elif "g" <= ch <= "z":
            count += (ord(ch) - ord("g") + 1) * 20
        elif ch == ",":
            cur += "0" * (width - len(cur)); flush()
        elif ch == "!":
            cur += "F" * (width - len(cur)); flush()
        elif ch == ":":
            cur = prev; flush()
        else:
            cur += ch * (count or 1); count = 0
            if len(cur) == width:
                flush()
            elif len(cur) > width:
                raise ValueError("row overflow")
    if len(rows) != height:
        raise ValueError("got %d rows, expected %d" % (len(rows), height))
    return bytes.fromhex("".join(rows))


def parse(zpl):
    m = re.search(r"\^GFA,(\d+),(\d+),(\d+),([^^]*)\^FS", zpl)
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)


print("\n=== ZPL encoder round-trip ===")
rnd = random.Random(1234)
samples = []
for w, h in [(1, 1), (8, 3), (13, 7), (812, 40), (832, 25)]:
    stride = (w + 7) // 8
    # mix of blank rows, full rows, repeated rows, long runs and noise
    rows = []
    for y in range(h):
        kind = rnd.choice(["blank", "full", "repeat", "runs", "noise"])
        if kind == "blank":
            r = bytes(stride)
        elif kind == "full":
            r = b"\xff" * stride
        elif kind == "repeat" and rows:
            r = rows[-1]
        elif kind == "runs":
            r = bytes(rnd.choice([0, 0xFF, 0x0F, 0xAA]) for _ in range(stride))
            r = r[: rnd.randrange(stride + 1)] + bytes(stride)
            r = r[:stride]
        else:
            r = bytes(rnd.randrange(256) for _ in range(stride))
        rows.append(r)
    samples.append((w, h, b"".join(rows)))
# a long run to exercise counts > 400
samples.append((832 * 2, 2, b"\x00" * 104 + b"\x11" * 104 + b"\x22" * 208))

for w, h, bits in samples:
    zpl = server.bitmap_to_zpl(bits, w, h, copies=2, darkness=5, speed=3).decode()
    b, c, d, data = parse(zpl)
    try:
        back = decode_gfa(data, d, h)
        ok = back == bits and b == c == len(bits) and d == (w + 7) // 8
        detail = "%dx%d: %d bytes -> %d chars" % (w, h, len(bits), len(data))
    except Exception as exc:                       # noqa: BLE001
        ok, detail = False, "%dx%d: %s" % (w, h, exc)
    check("round-trip", ok, detail)

zpl = server.bitmap_to_zpl(bytes(102 * 1218), 812, 1218, copies=3, darkness=-4, speed=2).decode()
check("blank 4x6 is tiny", len(zpl) < 1400, "(%d bytes)" % len(zpl))
check("header fields", all(t in zpl for t in ("^PW812", "^LL1218", "^PR2,2,2", "^MD-4", "^PQ3^XZ")), zpl[:60])
check("no darkness/speed unless asked",
      "^MD" not in server.bitmap_to_zpl(b"\x00", 1, 1).decode()
      and "^PR" not in server.bitmap_to_zpl(b"\x00", 1, 1).decode())


print("\n=== /api/print-bitmap end to end (fake lp) ===")
spool = tempfile.mkdtemp()
fakebin = tempfile.mkdtemp()
lp = os.path.join(fakebin, "lp")
with open(lp, "w") as fh:
    fh.write("#!/bin/sh\n"
             "printf '%%s\\n' \"$@\" > %s/args\n"
             "for last; do :; done\n"
             "cp \"$last\" %s/job\n"
             "echo 'request id is Zebra-1 (1 file(s))'\n" % (spool, spool))
os.chmod(lp, os.stat(lp).st_mode | stat.S_IEXEC)
os.environ["PATH"] = fakebin + os.pathsep + os.environ["PATH"]

W, H = 812, 1218
STRIDE = (W + 7) // 8
bits = bytearray(STRIDE * H)
for y in range(100, 400):                          # a crude barcode: 3-dot bars
    for x in range(100, 700):
        if (x // 3) % 2 == 0:
            bits[y * STRIDE + x // 8] |= 0x80 >> (x % 8)
bits = bytes(bits)


def post(headers, body):
    h = {"Content-Type": "application/octet-stream"}
    h.update(headers)
    r = urllib.request.Request(BASE + "/api/print-bitmap", method="POST",
                               data=body, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


p = start({"CUPS_HOST": "192.168.1.50", "CUPS_PRINTER": "Zebra_GK420d",
                     "PRINT_ALLOW_CIDRS": "127.0.0.1/32"})
try:
    s, j = post({"X-Width": str(W), "X-Height": str(H), "X-Copies": "2",
                 "X-Darkness": "8", "X-Speed": "2"}, bits)
    check("accepted", s == 200 and j.get("ok"), "HTTP %s %s" % (s, j))
    args = open(os.path.join(spool, "args")).read().split("\n")
    check("lp gets -o raw", "-o" in args and "raw" in args, str(args))
    check("lp copies left at 1 (copies are ^PQ)", args[args.index("-n") + 1] == "1")
    job = open(os.path.join(spool, "job")).read()
    b, c, d, data = parse(job)
    check("job decodes to the exact bitmap", decode_gfa(data, d, H) == bits,
          "(%d bytes of ZPL)" % len(job))
    check("job carries copies/darkness/speed", "^PQ2^XZ" in job and "^MD8" in job and "^PR2,2,2" in job)

    s, j = post({"X-Width": str(W), "X-Height": str(H)}, bits[:-1])
    check("short body refused", s == 400 and j.get("error") == "bad-bitmap-size", str(j))
    s, j = post({"X-Width": "2000", "X-Height": "10"}, bytes(250 * 10))
    check("too wide refused", s == 400 and j.get("error") == "bad-param", str(j))
    s, j = post({"X-Width": "8", "X-Height": "1", "X-Darkness": "99"}, b"\x00")
    check("darkness out of range refused", s == 400, str(j))
    s, j = post({"X-Height": "1"}, b"\x00")
    check("missing width refused", s == 400, str(j))
finally:
    p.terminate()
    p.wait(timeout=5)

p = start({"CUPS_HOST": "192.168.1.50", "CUPS_PRINTER": "Zebra_GK420d",
                     "PRINT_ALLOW_CIDRS": "192.168.99.0/24"})
try:
    s, j = post({"X-Width": "8", "X-Height": "1"}, b"\x00")
    check("off-network refused before anything else", s == 403 and j.get("error") == "off-network", str(j))
finally:
    p.terminate()
    p.wait(timeout=5)

print("=" * 60)
if FAILURES:
    print("FAILURES (%d):" % len(FAILURES))
    for f in FAILURES:
        print("  - " + f)
    sys.exit(1)
print("ALL ZPL CHECKS PASSED")
