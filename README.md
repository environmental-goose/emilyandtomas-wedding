# Emily & Tomas — Wedding Photo Sharing

A guest photo upload + live gallery for the wedding, running entirely on
Cloudflare (a Worker + R2). No database, no third-party accounts for
guests, no frontend build step — plain HTML/CSS/JS.

## How it works

- `index.html` — landing page with two buttons: Upload / Gallery.
- `upload.html` + `upload.js` — the upload form (name + photo picker).
- `gallery.html` + `gallery.js` — the live photo grid + lightbox +
  download. Polls every 15s, pauses while the tab is hidden, and only
  touches the DOM for photos that actually changed (added or deleted).
- `admin.html` + `admin.js` — password-gated page at `/admin` for
  bulk-deleting photos or downloading a selection as a `.zip`
  (zipped client-side via `fflate`, no server-side zip work needed).
- `style.css` — shared styling for all of the above.
- `worker/index.js` — the one server-side script. Routes:
  `POST /api/upload`, `GET /api/photos`, `GET /photos/<kind>/<id>.jpg`,
  `GET /api/admin/verify`, `POST /api/admin/delete`, plus explicit
  clean-URL routes for `/`, `/upload`, `/gallery`, `/admin`. Everything
  else falls through to `env.ASSETS.fetch(request)` (the static files
  above).

### Admin page

`/admin` is gated by a shared password (`ADMIN_PASSWORD` near the top of
`worker/index.js`, currently `natrocks`) checked on every admin API call
— this is a deterrent, not real security, consistent with the rest of
the app having no guest auth either. **If this repo is public on
GitHub, that password is visible in the source** — change it in
`worker/index.js` if you want a different one; it takes effect on the
next deploy.
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
