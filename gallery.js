(function () {
  const grid = document.getElementById('grid');
  const emptyState = document.getElementById('emptyState');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxDownload = document.getElementById('lightboxDownload');
  const closeBtn = document.getElementById('lightboxClose');
  const prevBtn = document.getElementById('lightboxPrev');
  const nextBtn = document.getElementById('lightboxNext');

  let items = [];
  const renderedIds = new Set();
  let currentIndex = 0;
  let pollTimer = null;

  // Fetches the current full list and reconciles the DOM incrementally —
  // only new photos get new <img> elements, and anything deleted (via the
  // admin page) gets removed. This avoids re-downloading/re-rendering
  // everything already on screen every 15 seconds, which matters a lot
  // on a mobile connection.
  async function refresh() {
    try {
      const res = await fetch('/api/photos?limit=300');
      const data = await res.json();
      const fresh = data.items || [];
      const freshIds = new Set(fresh.map(i => i.id));

      renderedIds.forEach(id => {
        if (!freshIds.has(id)) {
          renderedIds.delete(id);
          const el = grid.querySelector('[data-id="' + id + '"]');
          if (el) el.remove();
        }
      });

      const newOnes = fresh.filter(item => !renderedIds.has(item.id));
      items = fresh;
      if (newOnes.length) {
        newOnes.forEach(item => renderedIds.add(item.id));
        prependItems(newOnes);
      }
      emptyState.hidden = fresh.length > 0;
    } catch (e) {
      // silent — the next poll will retry
    }
  }

  function prependItems(newItems) {
    const frag = document.createDocumentFragment();
    newItems.forEach(item => frag.appendChild(makeGridItem(item)));
    grid.prepend(frag);
  }

  function makeGridItem(item) {
    const btn = document.createElement('button');
    btn.className = 'grid-item';
    btn.dataset.id = item.id;
    btn.innerHTML = '<img src="' + item.thumbUrl + '" loading="lazy" decoding="async" alt="Photo from ' + escapeHtml(item.guestName) + '">';
    btn.onclick = () => openLightboxById(item.id);
    return btn;
  }

  function openLightboxById(id) {
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) return;
    currentIndex = idx;
    updateLightbox();
    lightbox.hidden = false;
  }
  function updateLightbox() {
    const item = items[currentIndex];
    lightboxImg.src = item.fullUrl;
    lightboxCaption.textContent = 'Uploaded by ' + item.guestName;
    lightboxDownload.href = item.fullUrl + '?dl=1';
  }
  closeBtn.onclick = () => { lightbox.hidden = true; };
  prevBtn.onclick = () => { currentIndex = (currentIndex - 1 + items.length) % items.length; updateLightbox(); };
  nextBtn.onclick = () => { currentIndex = (currentIndex + 1) % items.length; updateLightbox(); };
  lightbox.addEventListener('click', e => { if (e.target === lightbox) lightbox.hidden = true; });
  document.addEventListener('keydown', e => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') lightbox.hidden = true;
    if (e.key === 'ArrowLeft') prevBtn.onclick();
    if (e.key === 'ArrowRight') nextBtn.onclick();
  });

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(refresh, 15000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Pause polling when the tab isn't visible — saves battery and mobile
  // data, and picks back up (with an immediate refresh) when it returns.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { refresh(); startPolling(); }
  });

  refresh();
  startPolling();
})();
