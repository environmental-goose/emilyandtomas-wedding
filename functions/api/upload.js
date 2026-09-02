// POST /api/upload
// Streams one file (thumb or full) straight into R2. No database —
// the guest's name and upload time are stored as R2 custom metadata.
const MAX_BYTES = 60 * 1024 * 1024; // 60MB per part, safety net

export async function onRequestPost(context) {
  const { request, env } = context;

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
