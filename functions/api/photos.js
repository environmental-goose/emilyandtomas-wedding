// GET /api/photos
// Lists everything under full/ in the bucket and returns gallery-ready JSON.
// No database: R2's own listing + each object's custom metadata is the source of truth.
export async function onRequestGet(context) {
  const { env, request } = context;
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
