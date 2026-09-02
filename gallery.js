// Gallery: fetches the full (already server-sorted-by-taken-time) photo
// list, then renders it progressively (client-side "infinite scroll") so
// the DOM never has to hold thousands of nodes at once. Tapping a photo
// opens a full-screen swipeable viewer.

const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const sentinel = document.getElementById('sentinel');

const viewer = document.getElementById('viewer');
const viewerImg = document.getElementById('viewerImg');
const viewerCaption = document.getElementById('viewerCaption');
const viewerFigure = document.getElementById('viewerFigure');
const viewerClose = document.getElementById('viewerClose');
const viewerDownload = document.getElementById('viewerDownload');
const viewerPrev = document.getElementById('viewerPrev');
const viewerNext = document.getElementById('viewerNext');

const BATCH = 30;
const POLL_MS = 5000;

let allItems = [];
let renderedCount = 0;
let renderedIds = [];
let currentViewerIndex = -1;
let pollTimer = null;

async function fetchItems() {
  const res = await fetch('/api/photos?limit=1000');
  if (!res.ok) throw new Error('failed to fetch photos');
  const data = await res.json();
  return data.items || [];
}

function idsOf(items) {
  return items.map(i => i.id);
}

function sameSequence(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function refresh() {
  let items;
  try {
    items = await fetchItems();
  } catch (e) {
    return;
  }
  allItems = items;
  emptyState.hidden = allItems.length > 0;

  const targetCount = Math.min(Math.max(renderedCount, BATCH), allItems.length);
  const newSlice = allItems.slice(0, targetCount);
  const newIds = idsOf(newSlice);

  if (!sameSequence(newIds, renderedIds)) {
    renderedCount = targetCount;
    renderedIds = newIds;
    renderSlice();
  }
}

function renderSlice() {
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  allItems.slice(0, renderedCount).forEach((item, index) => {
    frag.appendChild(makeGridItem(item, index));
  });
  grid.appendChild(frag);
}

function appendSlice(fromIndex, toIndex) {
  const frag = document.createDocumentFragment();
  for (let i = fromIndex; i < toIndex; i++) {
    frag.appendChild(makeGridItem(allItems[i], i));
  }
  grid.appendChild(frag);
  renderedIds = idsOf(allItems.slice(0, renderedCount));
}

function makeGridItem(item, index) {
  const btn = document.createElement('button');
  btn.className = 'grid-item';
  btn.type = 'button';
  btn.setAttribute('aria-label', `Photo by ${item.guestName}`);
  const img = document.createElement('img');
  img.src = item.thumbUrl;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  btn.appendChild(img);
  btn.addEventListener('click', () => openViewer(index));
  return btn;
}

function loadMore() {
  if (renderedCount >= allItems.length) return;
  const from = renderedCount;
  const to = Math.min(renderedCount + BATCH, allItems.length);
  renderedCount = to;
  appendSlice(from, to);
}

const observer = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) loadMore();
}, { rootMargin: '600px' });
observer.observe(sentinel);

// ---- full-screen viewer ----

function openViewer(index) {
  currentViewerIndex = index;
  updateViewer();
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeViewer() {
  viewer.hidden = true;
  document.body.style.overflow = '';
}

function updateViewer() {
  const item = allItems[currentViewerIndex];
  if (!item) return;
  viewerImg.src = item.fullUrl;
  viewerImg.alt = `Photo by ${item.guestName}`;
  viewerCaption.textContent = item.guestName ? `Shared by ${item.guestName}` : '';
}

function goPrev() {
  if (currentViewerIndex > 0) {
    currentViewerIndex--;
    updateViewer();
  }
}

function goNext() {
  if (currentViewerIndex < allItems.length - 1) {
    currentViewerIndex++;
    updateViewer();
    if (currentViewerIndex >= renderedCount - 5) loadMore();
  }
}

viewerClose.addEventListener('click', closeViewer);
viewerPrev.addEventListener('click', goPrev);
viewerNext.addEventListener('click', goNext);

// Downloading straight to the Photos app on iPhone means going through the
// native share sheet (Web Share API with a file) rather than a plain
// <a download>, which on iOS Safari saves into Files instead. Desktop /
// browsers without file-sharing support fall back to a normal download.
viewerDownload.addEventListener('click', async () => {
  const item = allItems[currentViewerIndex];
  if (!item) return;

  const originalLabel = viewerDownload.textContent;
  viewerDownload.disabled = true;
  viewerDownload.textContent = 'Preparing…';

  try {
    const res = await fetch(item.fullUrl);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    const filename = item.originalName || `${item.id}.jpg`;
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (e) {
    // The user cancelling the native share sheet throws AbortError — not
    // a real failure, so don't show an error for that case.
    if (!e || e.name !== 'AbortError') {
      alert('Download failed — please try again.');
    }
  } finally {
    viewerDownload.disabled = false;
    viewerDownload.textContent = originalLabel;
  }
});

let touchStartX = 0, touchStartY = 0;
viewerFigure.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
}, { passive: true });

viewerFigure.addEventListener('touchend', e => {
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) goNext();
    else goPrev();
  }
}, { passive: true });

// ---- visibility-aware polling ----

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { refresh(); startPolling(); }
});

refresh();
startPolling();
