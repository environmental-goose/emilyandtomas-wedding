# Emily & Tomas — Wedding Photo Sharing

A guest photo upload + live gallery for the wedding, running entirely on
Cloudflare (a Worker + R2). No database, no third-party accounts for
guests, no frontend build step — plain HTML/CSS/JS.

## How it works

- `index.html` — landing page with two buttons: Upload Photos / View
  Gallery. Unchanged regardless of what's below.
- `upload.html` + `upload.js` — back button, name field, one "Choose
  Photos" button. Selecting photos starts uploading immediately (max 3
  concurrent); a modal popup shows overall progress with a "don't leave
  this page" warning, then flips to a completion state (or a
  retry-failed state if anything errored) with a "View Gallery" button.
  Each photo uploads as a client-resized JPEG thumbnail plus the full-res
  original, and `exifr` (loaded from a CDN) reads the photo's EXIF
  `DateTimeOriginal` client-side so the gallery can sort by when it was
  actually taken.
- `gallery.html` + `gallery.js` — back button, a dense 5-across grid
  (thumbnails only), sorted by EXIF taken-time (falling back to upload
  time when a photo has no EXIF data). The full list is fetched once and
  then rendered progressively client-side as you scroll ("infinite
  scroll" without server-side pagination — R2 can't sort by EXIF date
  itself, so this app always fetches the full, already-sorted list and
  reveals more of it as needed). Tapping a photo opens a full-screen
  viewer that supports swiping left/right to move between photos, with a
  close button and a small download button. Polls every 5s, pauses while
  the tab is hidden, and only re-renders the grid when the visible slice
  actually changed.
- `admin.html` + `admin.js` — back button, password-gated page at
  `/admin` for bulk-deleting photos or downloading a selection as a
  `.zip` (zipped client-side via `fflate`, no server-side zip work
  needed).
- `style.css` — shared styling for all of the above, including the
  shared topbar/back-button pattern used on upload, gallery, and admin.
- `worker/index.js` — the one server-side script. Routes:
  `POST /api/upload`, `GET /api/photos`, `GET /photos/<kind>/<id>.jpg`,
  `GET /api/admin/verify`, `POST /api/admin/delete`, plus explicit
  clean-URL routes for `/`, `/upload`, `/gallery`, `/admin`. Everything
  else falls through to `env.ASSETS.fetch(request)` (the static files
  above). `POST /api/upload` accepts an optional `takenAt` field (the
  EXIF date read client-side); `GET /api/photos` sorts by that when
  present, otherwise by upload time.

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
