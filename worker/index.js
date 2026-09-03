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
  const listed = await env.PHOTOS_BUCKET.list({
    prefix: 'full/',
    limit,
    include: ['customMetadata'],
  });

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
    return {
      id,
      thumbUrl: `/photos/thumb/${id}.jpg`,
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
  // Oldest taken first, so the gallery reads chronologically top to bottom.
  }).sort((a, b) => new Date(a.sortTime) - new Date(b.sortTime));

  return new Response(JSON.stringify({ items }), {
    headers: { 'content-type': 'application/json' },
  });
}

// GET /photos/<kind>/<id>.jpg — streams an object straight out of R2.
// Add ?dl=1 to force a download instead of an inline view.
async function handlePhotoServe(request, env, key) {
  const obj = await env.PHOTOS_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  const url = new URL(request.url);
  if (url.searchParams.get('dl')) {
    const filename = (obj.customMetadata && obj.customMetadata.originalName) || key.split('/').pop();
    headers.set('content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
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
