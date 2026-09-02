# Emily & Tomas — Wedding Photo Sharing

A guest photo upload + live gallery for the wedding, built to run entirely
on Cloudflare (Pages + Pages Functions + R2). No database, no third-party
accounts for guests, no build step for the frontend — plain HTML/CSS/JS.

## How it works

- `index.html` — upload page (name + photo picker, drag & drop).
- `gallery.html` — live gallery grid with a lightbox and download button.
- `upload.js` — client-side upload queue (max 3 concurrent), generates a
  small JPEG thumbnail in-browser (via `<canvas>`) before uploading it
  alongside the full-res original, retries a failed upload once
  automatically, and offers a manual retry button after that.
- `functions/api/upload.js` — Pages Function, streams a file straight into
  R2. Stores guest name / original filename / upload time as R2 custom
  metadata (no database).
- `functions/api/photos.js` — Pages Function, lists the bucket for the
  gallery to poll.
- `functions/photos/[[path]].js` — Pages Function, streams an object back
  out of R2 (thumbnail or full-res); add `?dl=1` to force a download.

## One-time Cloudflare setup

1. **Create the R2 bucket** — Cloudflare dashboard → R2 → Create bucket,
   e.g. `emilyandtomas-wedding-photos`.
2. **Create the Pages project** — Cloudflare dashboard → Workers & Pages →
   Create → Pages → connect this GitHub repo. Build settings: no build
   command needed, output directory `/` (root) — it's all static files.
3. **Bind the bucket** — in the Pages project → Settings → Bindings →
   Add → R2 bucket → variable name exactly `PHOTOS_BUCKET`, pointing at
   the bucket from step 1. (Must match the binding name used in the
   `functions/*.js` files.) Redeploy after adding it.
4. **Custom domain** — Pages project → Custom domains → add
   `emilyandtomas.natberman.com`. Since natberman.com's DNS is already on
   Cloudflare, this just needs the CNAME Cloudflare proposes to be
   confirmed — no external DNS changes required.
5. Push to `main` — Cloudflare Pages auto-deploys on every push.

## Known limits worth knowing about

- R2 free tier: 10GB storage, 1M writes/mo, 10M reads/mo, egress always
  free. Plenty for one wedding.
- Per-file cap is 60MB (see `MAX_FILE_BYTES` / `MAX_BYTES` in
  `upload.js` and `functions/api/upload.js`) — raise it in both places if
  needed.
- HEIC photos (iPhone default format): the in-browser thumbnail step
  relies on `createImageBitmap`, which can't decode HEIC in every browser.
  If a thumbnail fails to generate, the app falls back to using the
  full-res image as its own thumbnail rather than failing the upload.
  Test with a real iPhone before the wedding.
