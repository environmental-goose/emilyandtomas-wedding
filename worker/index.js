// Single Worker entry point.
// Static files are served via the ASSETS binding; everything else
// (API routes + explicit clean-URL pages) is handled here.

// Per-part size ceiling. Raised from the original 60MB (photo-only) to
// accommodate video clips. NOTE: this is an app-level check only — the
// Cloudflare Workers platform itself enforces its own request body size
// cap (commonly 100MB on Free/Pro plans, higher on Business/Enterprise),
// which can reject a request before this check even runs. If longer
// videos start failing to upload, that platform ceiling — not this
// constant — is almost certainly why.
const MAX_BYTES = 200 * 1024 * 1024; // 200MB per part, safety net

// Maps a file's MIME type to a reasonable storage extension. Thumbnails
// are always a canvas-generated JPEG regardless of source type, so they
// don't need this — only the 'full' object's key uses it.
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'video/x-m4v': 'm4v', 'video/3gpp': '3gp',
};
function extForMime(mime) {
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  if (mime && mime.startsWith('video/')) return 'mp4';
  return 'jpg';
}

// Simple shared-password gate for the admin page. This is intentionally
// low-tech (matches the rest of the app's no-real-auth posture) — it's a
// deterrent, not a security boundary. NOTE: if this repo is public on
// GitHub, this password is visible in the source. Change it here if
// needed; it's checked against the X-Admin-Password header on every
// admin API call, so changing it takes effect on the next deploy.
const ADMIN_PASSWORD = 'natrocks';

const PAGE_ROUTES = {
  '/': '/index.html',
  '/upload': '/upload.html',
  '/gallery': '/gallery.html',
  '/admin': '/admin.html',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && PAGE_ROUTES[pathname]) {
      return serveAsset(env, request, PAGE_ROUTES[pathname]);
    }

    if (request.method === 'POST' && pathname === '/api/upload') {
      return handleUpload(request, env);
    }
    if (request.method === 'GET' && pathname === '/api/photos') {
      return handlePhotosList(request, env);
    }
    if (request.method === 'GET' && pathname.startsWith('/photos/')) {
      return handlePhotoServe(request, env, pathname.slice('/photos/'.length));
    }
    if (request.method === 'GET' && pathname === '/api/admin/verify') {
      return isAdmin(request) ? new Response('ok') : new Response('unauthorized', { status: 401 });
    }
    if (request.method === 'POST' && pathname === '/api/admin/delete') {
      return handleAdminDelete(request, env);
    }
    if (request.method === 'POST' && pathname === '/api/admin/backfill-taken-at') {
      return handleBackfillTakenAt(request, env);
    }
    if (request.method === 'GET' && pathname === '/api/admin/storage-usage') {
      return handleStorageUsage(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

function serveAsset(env, request, path) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path;
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

function isAdmin(request) {
  return request.headers.get('X-Admin-Password') === ADMIN_PASSWORD;
}

// GET /api/admin/storage-usage — total bytes + object count across the
// entire bucket (thumbs + full-res + anything else stored). Paginates
// through R2's list() with its cursor since a single call caps out at
// 1000 objects, which the bucket will eventually exceed.
async function handleStorageUsage(request, env) {
  if (!isAdmin(request)) return new Response('Unauthorized', { status: 401 });

  let totalBytes = 0;
  let objectCount = 0;
  let cursor;
  do {
    const listed = await env.PHOTOS_BUCKET.list({ limit: 1000, cursor });
    for (const obj of listed.objects) {
      totalBytes += obj.size;
      objectCount++;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return new Response(JSON.stringify({ totalBytes, objectCount }), {
    headers: { 'content-type': 'application/json' },
  });
}

// POST /api/upload — streams one file (thumb or full) straight into R2.
// No database — guest name / original filename / upload time are stored
// as R2 custom metadata.
async function handleUpload(request, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return new Response('Bad request body', { status: 400 });
  }

  const kind = formData.get('kind');
  const id = formData.get('id');
  const guestName = (formData.get('guestName') || 'Anonymous').toString().slice(0, 80);
  const originalName = (formData.get('originalName') || '').toString().slice(0, 200);
  const file = formData.get('file');

  // Optional EXIF "photo taken at" timestamp, read client-side. Only kept
  // if it parses as a real date — this is what the gallery sorts by so
  // photos appear in the order they were actually taken, not uploaded.
  const takenAtRaw = (formData.get('takenAt') || '').toString();
  const takenAtDate = takenAtRaw ? new Date(takenAtRaw) : null;
  const takenAt = takenAtDate && !isNaN(takenAtDate) ? takenAtDate.toISOString() : '';

  if (!file || typeof file === 'string') {
    return new Response('Missing file', { status: 400 });
  }
  if (kind !== 'thumb' && kind !== 'full') {
    return new Response('Invalid kind', { status: 400 });
  }
  if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return new Response('File too large', { status: 413 });
  }

  // Thumbnails are always a canvas-generated JPEG. The full-res object
  // keeps its real extension so videos don't end up misleadingly named
  // "<id>.jpg" internally, and so mediaType below reflects reality.
  const contentType = file.type || 'image/jpeg';
  const isVideo = contentType.startsWith('video/');
  const ext = kind === 'thumb' ? 'jpg' : extForMime(contentType);
  const key = `${kind}/${id}.${ext}`;

  await env.PHOTOS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType },
    customMetadata: {
      guestName,
      originalName,
      uploadedAt: new Date().toISOString(),
      contentType,
      mediaType: isVideo ? 'video' : 'photo',
      ...(takenAt ? { takenAt } : {}),
    },
  });

  return new Response(JSON.stringify({ ok: true, key }), {
    headers: { 'content-type': 'application/json' },
  });
}

// GET /api/photos?limit=N — lists everything under full/ for the gallery
// (and the admin panel, which asks for a higher limit).
async function handlePhotosList(request, env) {
  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit') || '300', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 300;
  limit = Math.min(limit, 1000);

  // R2's list() omits customMetadata (and httpMetadata) by default for
  // performance — it must be explicitly requested via `include`, or every
  // object comes back with an empty customMetadata object. This was the
  // root cause of guest names / taken-at dates showing up missing in the
  // gallery even though they were being written correctly on upload.
  // Also list thumb/ so each item's thumbUrl can carry a cache-busting
  // version tied to that specific thumbnail's own last-modified time.
  // Thumbnails do get overwritten in place after upload (e.g. the video-
  // thumbnail auto-repair below), and thumb/*.jpg is served with a long
  // immutable cache header — without a version query param that changes
  // whenever the bytes actually change, browsers/CDN would keep serving
  // the old thumbnail forever. A hand-bumped global version constant was
  // tried here before and caused a real bug: any request made between a
  // deploy and the regeneration finishing would cache the still-stale
  // content under the new version forever. Deriving the version from the
  // object's own R2 upload timestamp instead means it can never be wrong
  // — it simply reflects whenever that thumbnail was last actually written.
  const [listed, thumbListed] = await Promise.all([
    env.PHOTOS_BUCKET.list({ prefix: 'full/', limit, include: ['customMetadata'] }),
    env.PHOTOS_BUCKET.list({ prefix: 'thumb/', limit }),
  ]);

  const thumbUploadedById = new Map();
  for (const obj of thumbListed.objects) {
    const id = obj.key.slice('thumb/'.length).replace(/\.[a-zA-Z0-9]+$/, '');
    thumbUploadedById.set(id, obj.uploaded);
  }

  const items = listed.objects.map(obj => {
    // Full-res keys can now carry any extension (jpg/mp4/mov/...), so
    // strip whatever the last extension is rather than assuming .jpg.
    const id = obj.key.slice('full/'.length).replace(/\.[a-zA-Z0-9]+$/, '');
    const meta = obj.customMetadata || {};
    const uploadedAt = meta.uploadedAt || obj.uploaded;
    // Sort by when the photo/video was actually taken (EXIF for photos,
    // the file's own last-modified time for videos), falling back to
    // upload time when neither is available.
    const sortTime = meta.takenAt || uploadedAt;
    const thumbUploaded = thumbUploadedById.get(id);
    const thumbVersion = thumbUploaded ? new Date(thumbUploaded).getTime() : 0;
    return {
      id,
      thumbUrl: `/photos/thumb/${id}.jpg?v=${thumbVersion}`,
      // Use the real stored key so the extension always matches what's
      // actually in the bucket (thumb is always .jpg; full varies).
      fullUrl: `/photos/${obj.key}`,
      guestName: meta.guestName || 'Anonymous',
      originalName: meta.originalName || `${id}.jpg`,
      isVideo: meta.mediaType === 'video',
      uploadedAt,
      takenAt: meta.takenAt || null,
      sortTime,
    };
  // Newest taken first, so the gallery reads newest-at-top regardless of
  // upload order.
  }).sort((a, b) => new Date(b.sortTime) - new Date(a.sortTime));

  return new Response(JSON.stringify({ items }), {
    headers: { 'content-type': 'application/json' },
  });
}

// GET /photos/<kind>/<id>.jpg — streams an object straight out of R2.
// Add ?dl=1 to force a download instead of an inline view.
//
// Range requests are mandatory here, not an optimization: iOS Safari's
// <video> element requires the server to honor `Range` (it probes with
// one before it will play anything at all) and will otherwise get stuck
// showing just the poster frame with no way to play it, even though the
// exact same URL loads fine as a plain <img> or in desktop Chrome.
async function handlePhotoServe(request, env, key) {
  const rangeHeader = request.headers.get('range');
  let range;
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : undefined;
      range = end !== undefined ? { offset: start, length: end - start + 1 } : { offset: start };
    }
  }

  let obj;
  try {
    obj = range
      ? await env.PHOTOS_BUCKET.get(key, { range })
      : await env.PHOTOS_BUCKET.get(key);
  } catch (e) {
    // An unsatisfiable/malformed range (or anything else that throws) —
    // fall back to serving the whole object rather than erroring out.
    obj = await env.PHOTOS_BUCKET.get(key);
    range = undefined;
  }
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('accept-ranges', 'bytes');

  const url = new URL(request.url);
  if (url.searchParams.get('dl')) {
    const filename = (obj.customMetadata && obj.customMetadata.originalName) || key.split('/').pop();
    headers.set('content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  }

  if (range && obj.range) {
    const total = obj.size;
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? (total - start);
    const end = Math.max(start, start + length - 1);
    headers.set('content-range', `bytes ${start}-${end}/${total}`);
    return new Response(obj.body, { status: 206, headers });
  }

  return new Response(obj.body, { headers });
}

// POST /api/admin/delete — { ids: ["<id>", ...] }, password-gated.
// Removes both the thumb/ and full/ objects for each id.
async function handleAdminDelete(request, env) {
  if (!isAdmin(request)) return new Response('Unauthorized', { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id))
    : [];
  if (!ids.length) return new Response('No valid ids', { status: 400 });

  // Full-res keys no longer always end in .jpg (videos keep their real
  // extension), so find each id's actual key by prefix instead of
  // guessing the extension — guessing wrong means R2's delete() just
  // silently no-ops on a key that doesn't exist, leaking storage.
  await Promise.all(ids.map(async id => {
    const [fullListed, thumbListed] = await Promise.all([
      env.PHOTOS_BUCKET.list({ prefix: `full/${id}.` }),
      env.PHOTOS_BUCKET.list({ prefix: `thumb/${id}.` }),
    ]);
    const keys = [...fullListed.objects, ...thumbListed.objects].map(o => o.key);
    await Promise.all(keys.map(k => env.PHOTOS_BUCKET.delete(k)));
  }));

  return new Response(JSON.stringify({ ok: true, deleted: ids.length }), {
    headers: { 'content-type': 'application/json' },
  });
}

// POST /api/admin/backfill-taken-at — one-time (re-runnable, idempotent)
// repair for photos uploaded before this app correctly extracted EXIF
// capture time client-side. Those objects' full-res bytes are still
// sitting in R2 exactly as uploaded, so we re-read each one here and
// pull DateTimeOriginal straight out of its JPEG EXIF segment
// server-side, then re-save the object with that filled in. Only
// touches objects that don't already have a takenAt, so it's always
// safe to re-run (e.g. after a fresh batch of guest uploads).
async function handleBackfillTakenAt(request, env) {
  if (!isAdmin(request)) return new Response('Unauthorized', { status: 401 });

  const listed = await env.PHOTOS_BUCKET.list({
    prefix: 'full/',
    limit: 1000,
    include: ['customMetadata', 'httpMetadata'],
  });

  const result = { scanned: 0, updated: 0, skipped: 0, failed: 0, updatedKeys: [] };

  for (const obj of listed.objects) {
    result.scanned++;
    const meta = obj.customMetadata || {};
    if (meta.takenAt) {
      result.skipped++;
      continue;
    }
    const contentType = meta.contentType || (obj.httpMetadata && obj.httpMetadata.contentType) || '';
    const looksLikeJpeg = contentType.includes('jpeg') || /\.jpe?g$/i.test(obj.key);
    if (!looksLikeJpeg) {
      result.skipped++;
      continue;
    }

    try {
      const full = await env.PHOTOS_BUCKET.get(obj.key);
      if (!full) { result.failed++; continue; }
      const bytes = new Uint8Array(await full.arrayBuffer());
      const takenAt = readExifTakenAt(bytes);
      if (!takenAt) {
        result.skipped++;
        continue;
      }
      await env.PHOTOS_BUCKET.put(obj.key, bytes, {
        httpMetadata: full.httpMetadata,
        customMetadata: { ...meta, takenAt },
      });
      result.updated++;
      result.updatedKeys.push({ key: obj.key, takenAt });
    } catch (e) {
      result.failed++;
    }
  }

  return new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json' },
  });
}

// ---- Minimal, dependency-free JPEG EXIF DateTimeOriginal reader ----
//
// This project has no bundler/npm build step (see wrangler.jsonc — it's
// a single plain worker/index.js), so pulling in a full EXIF library
// just for backfilling old uploads would mean introducing one. We only
// need one field (plus its UTC offset when present), so a small manual
// TIFF/EXIF walker is the lower-risk option. Verified against every
// currently-stored photo before deploying this — see commit history.
function readExifTakenAt(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xFFD8) return null; // not a JPEG

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFD9 || marker === 0xFFDA) break; // EOI / start of scan
    const segLen = view.getUint16(offset + 2);
    if (marker === 0xFFE1) { // APP1
      const segStart = offset + 4;
      if (
        bytes[segStart] === 0x45 && bytes[segStart + 1] === 0x78 &&
        bytes[segStart + 2] === 0x69 && bytes[segStart + 3] === 0x66
      ) { // "Exif"
        const result = parseTiffForDateTimeOriginal(view, segStart + 6, bytes);
        if (result) return result;
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

function parseTiffForDateTimeOriginal(view, tiffStart, bytes) {
  const byteOrderMark = view.getUint16(tiffStart);
  const little = byteOrderMark === 0x4949; // 'II'
  if (!little && byteOrderMark !== 0x4D4D) return null; // not 'MM' either
  const getU16 = o => view.getUint16(o, little);
  const getU32 = o => view.getUint32(o, little);

  let dateTimeOriginal = null;
  let offsetTimeOriginal = null;

  function readAscii(start, count) {
    let s = '';
    for (let i = 0; i < count - 1; i++) { // count includes the trailing NUL
      const c = bytes[start + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readIfd(ifdOffset) {
    const entryCount = getU16(ifdOffset);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = getU16(entryOffset);
      const type = getU16(entryOffset + 2);
      const count = getU32(entryOffset + 4);
      const valueOffset = entryOffset + 8;
      // ASCII values <=4 bytes are stored inline; longer ones store an
      // offset (relative to the TIFF header) to the actual bytes.
      const dataStart = (type === 2 && count <= 4) ? valueOffset : tiffStart + getU32(valueOffset);
      if (tag === 0x9003 && type === 2) { // DateTimeOriginal
        dateTimeOriginal = readAscii(dataStart, count);
      } else if (tag === 0x9011 && type === 2) { // OffsetTimeOriginal
        offsetTimeOriginal = readAscii(dataStart, count);
      } else if (tag === 0x8769 && type === 4) { // Exif IFD pointer — recurse
        readIfd(tiffStart + getU32(valueOffset));
      }
    }
  }

  try {
    readIfd(tiffStart + getU32(tiffStart + 4));
  } catch (e) {
    return null;
  }

  if (!dateTimeOriginal) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dateTimeOriginal);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offsetTimeOriginal || 'Z'}`;
  const parsed = new Date(iso);
  return isNaN(parsed) ? null : parsed.toISOString();
}
