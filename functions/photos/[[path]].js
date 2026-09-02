// GET /photos/<kind>/<id>.jpg
// Streams the object straight out of R2. Add ?dl=1 to force a download
// instead of an inline view (used by the gallery's Download button).
export async function onRequestGet(context) {
  const { env, params, request } = context;
  const key = Array.isArray(params.path) ? params.path.join('/') : params.path;

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
