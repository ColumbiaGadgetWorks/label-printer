# Handoff notes

Context from the chat that built the image-label feature (Oct–Nov 2026). It
covers only what is not already in the repo. The README is the main reference
for how the app works.

## Where things stand

- Everything is merged to `main` (fast-forward, no merge commits). The last
  commit is `66b7a85` ("Image page: PDF upload, auto-trim and auto-rotate on
  load").
- The user's problem was that barcodes printed from a screenshot via Windows
  came out dithered and uneven on a **Zebra GK420** (203 dpi). The fix was the
  image page: the browser converts to 1-bit, and the server sends raw ZPL to
  CUPS with `lp -o raw`.
- The user asked for, and got:
  - the image page
  - an Unraid template, with a wget install command
  - a container icon and a favicon
  - **Fit label** as the default and leftmost scaling option, with
    Barcode-safe in the middle
  - auto-trim and auto-rotate on load
  - PDF upload
- No requests are outstanding.

## Never verified on real hardware or real inputs

- **Nothing has been printed on the actual GK420.** The ZPL is checked against
  an independent decoder (`test_zpl.py`), and the `/api/print-bitmap` → `lp`
  path is tested only with a fake `lp`. The first real-print feedback from the
  user may surface:
  - CUPS raw-queue issues
  - `^LL` / media-length behaviour on gap media
  - darkness and speed tuning
- **Real carrier PDFs** (UPS/USPS/FedEx) are untested. Testing used hand-made
  vector PDFs. Carrier PDFs that embed the label as a raster image fall back to
  the ordinary image path, with no vector re-render.
- **The `docker-compose.nobuild.yml` / nginx variant** is untested. Its new
  `.mjs` / `.wasm` location blocks were never run, because no nginx was
  available.
- **The Docker image itself** is built and published by GitHub Actions. Nobody
  has confirmed it runs on the user's Unraid box beyond the first pull error,
  which was fixed by making the package public.

## User's environment

- **Unraid server.** The template is installed at
  `/boot/config/plugins/dockerMan/templates-user/my-label-printer.xml`.
  The user first installed it when it pointed at `:testing` and a feature-branch
  icon URL. They were told to switch to `:latest` and the `main` icon URL;
  whether they did is unknown.
- **CUPS** runs on a Raspberry Pi on the LAN. The real host and queue names
  were never given; the template defaults `192.168.1.50` and `Zebra_GK420d` are
  placeholders.
- **The user is on Windows**, which is where the original screenshot printing
  happened.
- **The repo is public.** The GHCR package
  `ghcr.io/columbiagadgetworks/label-printer` was made public by hand. GitHub
  created it private even though the repo is public; re-check this if the
  package is ever recreated.

## Session and tooling quirks

- **Push permissions.** Cloud sessions were assigned the branch
  `claude/serene-knuth-dw0n54`. Pushing to `main` (`git push origin HEAD:main`)
  was allowed, but **deleting a remote branch was refused (HTTP 403 from the
  git proxy)**. The user wants that branch gone, so ask them to delete it in
  the GitHub UI. It points at the same commit as `main`.
- **The user's way of working.** They ask for changes and then "merge to main".
  The pattern so far: commit on the session branch, then fast-forward `main`,
  then watch the `docker` workflow build `:latest`. Only push to `main` when the
  user asks for that change to be merged.
- **Browser testing** used the pre-installed Playwright (`npm root -g`) and
  Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. The scripts
  lived in the session scratchpad and are gone. To recreate the fixtures:
  - a barcode PNG generated with PIL, rendered at 125% display scaling with
    anti-aliasing to mimic a Windows screenshot
  - a two-page PDF written by hand: a letter page with a landscape 6×4 label
    box plus stray text, and a 4×6 page, both using non-embedded Helvetica-Bold
  - drive it through the `window.__labelImage` test hook in `web/image.js`
- **Static serving for manual checks:**
  `WEB_ROOT=$PWD/web PORT=8125 python3 server.py`. Don't stop it with
  `pkill -f server.py`, because that pattern also kills the shell running the
  command. Kill it by PID instead.

## Design decisions with reasons not obvious from the code

- **Smooth edges is on by default.** Smooth-then-threshold halved the
  bar-width error on a 125%-scaled screenshot, and gave identical output to
  nearest-neighbour on a clean 1:1 screenshot.
- **Stored-settings migration.** Settings saved by the earlier version are
  migrated with a `v: 2` field: an old saved `fit: 'integer'` becomes `fit`,
  because v1 stored its default whether or not the user chose it.
- **Server-built ZPL.** `/api/print-bitmap` accepts only pixels, and the
  server builds the ZPL. This is deliberate, so clients can't send printer
  commands such as `^JU` to save config.
- **pdf.js version.** pdf.js 6.3.289 is vendored, using the legacy build for
  Safari and older browsers. The scripting `quickjs-eval` wasm was removed as
  unused, and so were cmaps (so CJK PDFs without embedded fonts may render
  poorly). `isEvalSupported` no longer exists in v6.
