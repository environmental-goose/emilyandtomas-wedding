// Single Worker entry point.
// Static files (index.html, gallery.html, style.css, upload.js, gallery.js)
// are served via the ASSETS binding; everything else is handled here.
//
// (This replaces the old Pages-style `functions/` directory — that
// file-based-routing convention doesn't work on a plain Cloudflare Worker,
// which is what this project actually is. Everything now lives in this
// one script instead.)

const MAX_BYTES = 60 * 1024 * 1024; // 60MB per part, safety net

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/api/upload') {
      return handleUpload(request, env);
    }
    if (request.method === 'GET' && pathname === '/api/photos') {
      return handlePhotosList(request, env);
    }
    if (request.method === 'GET' && pathname.startsWith('/photos/')) {
      return handlePhotoServe(request, env, pathname.slice('/photos/'.length));
    }

    return env.ASSETS.fetch(request);
  },
};

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

  const key = `${kind}/${id}.jpg`;

  await env.PHOTOS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
    customMetadata: {
      guestName,
      originalName,
      uploadedAt: new Date().toISOString(),
    },
  });

  return new Response(JSON.stringify({ ok: true, key }), {
    headers: { 'content-type': 'application/json' },
  });
}

// GET /api/photos — lists everything under full/ for the gallery.
async function handlePhotosList(request, env) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') || undefined;

  const listed = await env.PHOTOS_BUCKET.list({
    prefix: 'full/',
    cursor,
    limit: 200,
  });

  const items = listed.objects.map(obj => {
    const id = obj.key.replace('full/', '').replace(/\.jpg$/, '');
    const meta = obj.customMetadata || {};
    return {
      id,
      thumbUrl: `/photos/thumb/${id}.jpg`,
      fullUrl: `/photos/full/${id}.jpg`,
      guestName: meta.guestName || 'Anonymous',
      uploadedAt: meta.uploadedAt || obj.uploaded,
    };
  }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  return new Response(JSON.stringify({
    items,
    cursor: listed.truncated ? listed.cursor : null,
  }), { headers: { 'content-type': 'application/json' } });
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
