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
  let currentIndex = 0;

  async function load() {
    try {
      const res = await fetch('/api/photos');
      const data = await res.json();
      items = data.items || [];
    } catch (e) {
      items = [];
    }
    render();
  }

  function render() {
    grid.innerHTML = '';
    emptyState.hidden = items.length > 0;
    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.className = 'grid-item';
      btn.innerHTML = '<img src="' + item.thumbUrl + '" loading="lazy" alt="Photo from ' + escapeHtml(item.guestName) + '">';
      btn.onclick = () => openLightbox(i);
      grid.appendChild(btn);
    });
  }

  function openLightbox(i) {
    currentIndex = i;
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

  load();
  setInterval(load, 15000);
})();
