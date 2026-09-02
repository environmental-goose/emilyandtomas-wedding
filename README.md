# Emily & Tomas — Wedding Photo Sharing

A guest photo upload + live gallery for the wedding, running entirely on
Cloudflare (a Worker + R2). No database, no third-party accounts for
guests, no frontend build step — plain HTML/CSS/JS.

## How it works

- `index.html` / `gallery.html` / `style.css` / `upload.js` / `gallery.js`
  — the static frontend, served directly by the Worker's assets binding.
- `worker/index.js` — the one server-side script. Handles three routes
  (`POST /api/upload`, `GET /api/photos`, `GET /photos/<kind>/<id>.jpg`)
  and falls through to `env.ASSETS.fetch(request)` for everything else
  (i.e. the static files above).
- `wrangler.jsonc` — declares the Worker's entry point, the assets
  directory, and the R2 bucket binding (`PHOTOS_BUCKET`). Because this
  lives in the repo, Cloudflare picks it up on every deploy — no manual
  dashboard configuration needed, and nothing gets reset on a rebuild.

Note: this used to be written as separate files under a `functions/`
directory (the Pages Functions convention). That convention only works
on classic Cloudflare Pages projects — this project is a plain Cloudflare
Worker, where it's silently ignored (404s). Everything server-side now
lives in the single `worker/index.js` file instead.

## One-time Cloudflare setup

1. **Create the R2 bucket** — Cloudflare dashboard → R2 → Create bucket,
   e.g. `emilyandtomas-wedding-photos` (must match the `bucket_name` in
   `wrangler.jsonc` if you rename it).
2. **Create the Worker project** — Cloudflare dashboard → Workers & Pages →
   Create → connect this GitHub repo, branch `main`. Because
   `wrangler.jsonc` is committed, Cloudflare Workers Builds reads it
   automatically — the R2 binding is applied on every deploy without
   touching the dashboard's Bindings UI at all.
3. **Custom domain** — Worker → Domains & Routes → Add Domain →
   `emilyandtomas.natberman.me`. Since natberman.me's DNS is already on
   Cloudflare, this creates the DNS record automatically.
4. Push to `main` — Cloudflare auto-deploys on every push.

## Known limits worth knowing about

- R2 free tier: 10GB storage, 1M writes/mo, 10M reads/mo, egress always
  free. Plenty for one wedding.
- Per-file cap is 60MB (`MAX_BYTES` in `worker/index.js` and `upload.js`)
  — raise it in both places if needed.
- HEIC photos (iPhone default format): the in-browser thumbnail step
  relies on `createImageBitmap`, which can't decode HEIC in every browser.
  If a thumbnail fails to generate, the app falls back to using the
  full-res image as its own thumbnail rather than failing the upload.
  Test with a real iPhone before the wedding.
