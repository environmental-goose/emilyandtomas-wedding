// Gallery: fetches the full (already server-sorted-by-taken-time) photo
// list, then renders it progressively (client-side "infinite scroll") so
// the DOM never has to hold thousands of nodes at once. Tapping a photo
// opens a full-screen swipeable viewer with a 3-pane sliding track (prev /
// current / next), pinch-to-zoom on the current photo, and a loading
// placeholder so an unloaded neighbor never gets mistaken for the current
// photo failing to change.

// iOS Safari fires its own non-standard gesture events for a two-finger
// pinch (in addition to touch events) and will perform its native
// page-zoom unless these are prevented — without this, pinch-to-zoom on
// a photo fights the browser's own zoom instead of driving our custom
// one. Locking the viewport (see gallery.html's <meta viewport>) handles
// most of it; this covers WebKit's separate gesture-event path. It's a
// no-op on browsers that don't fire these events.
['gesturestart', 'gesturechange', 'gestureend'].forEach(type => {
  document.addEventListener(type, e => e.preventDefault());
});

const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const sentinel = document.getElementById('sentinel');

const viewer = document.getElementById('viewer');
const viewerTrack = document.getElementById('viewerTrack');
const viewerCaption = document.getElementById('viewerCaption');
const viewerClose = document.getElementById('viewerClose');
const viewerDownload = document.getElementById('viewerDownload');
const viewerPrev = document.getElementById('viewerPrev');
const viewerNext = document.getElementById('viewerNext');
const viewerPrevBtn = document.getElementById('viewerPrevBtn');
const viewerNextBtn = document.getElementById('viewerNextBtn');

const slideEls = {
  prev: viewerTrack.querySelector('[data-slot="prev"]'),
  current: viewerTrack.querySelector('[data-slot="current"]'),
  next: viewerTrack.querySelector('[data-slot="next"]'),
};

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
  // The initial batch (or a batch refreshed in place) might not be tall
  // enough to fill the screen and push the sentinel out of view — in
  // that case there'd be nothing left to trigger further loading at all,
  // so proactively top up right after rendering rather than only ever
  // reacting to a later intersection change.
  fillViewportIfNeeded();
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

const VIDEO_BADGE_SVG = '<svg viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

function makeGridItem(item, index) {
  const btn = document.createElement('button');
  btn.className = 'grid-item';
  btn.type = 'button';
  btn.setAttribute('aria-label', `${item.isVideo ? 'Video' : 'Photo'} by ${item.guestName}`);
  const img = document.createElement('img');
  img.src = item.thumbUrl;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  btn.appendChild(img);
  if (item.isVideo) {
    const badge = document.createElement('span');
    badge.className = 'grid-item-video-badge';
    badge.innerHTML = VIDEO_BADGE_SVG;
    btn.appendChild(badge);
  }
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

const LOAD_MORE_ROOT_MARGIN = 600; // px — keep in sync with the observer's rootMargin below

// IntersectionObserver only fires when the sentinel's intersecting state
// actually *changes* (crosses the 0 threshold), not continuously while it
// stays intersecting. A batch of photos is often shorter than the 600px
// root margin, so after loading one batch the sentinel can still be
// sitting inside the trigger zone — no further transition ever happens,
// so the observer never fires again and the gallery silently stalls after
// just one page. It also never fires *usefully* the very first time,
// since observe() queues its initial callback before the first /api/photos
// response has even come back, when allItems is still empty. So instead
// of trusting a single observer event to mean "load one batch", this
// checks-and-loops on demand: keep loading batches for as long as the
// sentinel remains inside the trigger zone (or until everything is
// loaded), and it's called both from the observer and directly after any
// render, so it doesn't depend on a state transition actually occurring.
function fillViewportIfNeeded() {
  if (renderedCount >= allItems.length) return;
  const rect = sentinel.getBoundingClientRect();
  if (rect.top < window.innerHeight + LOAD_MORE_ROOT_MARGIN) {
    loadMore();
    fillViewportIfNeeded();
  }
}

const observer = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) fillViewportIfNeeded();
}, { rootMargin: `${LOAD_MORE_ROOT_MARGIN}px` });
observer.observe(sentinel);

// ---- full-screen viewer: 3-pane sliding track ----

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Fills one of the three fixed slide slots with an item's content (or
// empties it out at the ends of the list). Always shows the low-res
// thumbnail (already cached from the grid) immediately as a placeholder,
// then swaps in the full-resolution media once it has actually finished
// loading — this is what stops a swipe from ever leaving the *previous*
// photo on screen while the caption has already moved on to the new one.
// Grabs whatever frame the <video> element currently has decoded (called
// on 'loadeddata', i.e. the frame at the video's starting position — its
// first frame) and returns it as a data URL usable as a poster image.
// Same-origin video, so this never hits a tainted-canvas security error;
// any other failure just means we keep the existing (upload-time) poster.
function captureVideoFrame(videoEl) {
  try {
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w || !h) return null;
    const MAX_DIM = 480;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    return null;
  }
}

function loadSlide(slideEl, item, isCurrent) {
  if (!slideEl) return;
  const thumbImg = slideEl.querySelector('.slide-thumb');
  const fullImg = slideEl.querySelector('.slide-full');
  const fullVideo = slideEl.querySelector('.slide-full-video');
  const loadingEl = slideEl.querySelector('.slide-loading');

  // Stop and unload any video this slot was previously showing.
  if (fullVideo.getAttribute('src')) {
    fullVideo.pause();
    fullVideo.removeAttribute('src');
    fullVideo.load();
  }
  fullImg.onload = null;
  fullImg.onerror = null;
  fullVideo.oncanplay = null;
  fullVideo.onerror = null;
  fullVideo.onloadeddata = null;
  fullImg.style.transform = '';
  fullVideo.style.transform = '';

  if (!item) {
    // This slot has no photo (there's no prev before the first item, or
    // no next after the last). We deliberately do NOT use the `hidden`
    // attribute here: it forces display:none, which removes the slide
    // from the flex layout entirely and shifts its siblings into its
    // slot — since the track's resting transform assumes exactly three
    // fixed 100%-wide slots, that shift silently put the *next* photo's
    // slide where "current" is supposed to be, so opening the very first
    // photo actually showed the second one. visibility:hidden keeps the
    // slide's slot (and the 3-slot geometry) intact while making it
    // invisible and untouchable.
    slideEl.style.visibility = 'hidden';
    slideEl.dataset.itemId = '';
    return;
  }

  slideEl.style.visibility = '';
  slideEl.dataset.itemId = item.id;
  thumbImg.src = item.thumbUrl;
  thumbImg.alt = '';
  thumbImg.hidden = false;
  fullImg.hidden = true;
  fullVideo.hidden = true;
  loadingEl.hidden = false;

  const markLoaded = () => {
    if (slideEl.dataset.itemId !== item.id) return; // stale callback guard
    loadingEl.hidden = true;
    thumbImg.hidden = true;
  };

  if (item.isVideo) {
    // item.thumbUrl is the upload-time-generated thumbnail — used as an
    // immediate fallback poster — but as soon as the video's own first
    // frame actually decodes we swap the poster to that real frame so
    // the pre-play thumbnail always reflects the video itself.
    fullVideo.poster = item.thumbUrl;
    fullVideo.hidden = false;
    if (isCurrent) {
      // Only actually fetch video bytes for the slide the user is looking
      // at — neighbors just show their poster frame until swiped to.
      fullVideo.onloadeddata = () => {
        if (slideEl.dataset.itemId !== item.id) return; // stale guard
        const frame = captureVideoFrame(fullVideo);
        if (frame) fullVideo.poster = frame;
      };
      fullVideo.oncanplay = markLoaded;
      fullVideo.onerror = markLoaded;
      fullVideo.src = item.fullUrl;
    } else {
      loadingEl.hidden = true;
      thumbImg.hidden = true;
    }
  } else {
    fullImg.alt = `Photo by ${item.guestName}`;
    fullImg.hidden = false;
    fullImg.onload = markLoaded;
    fullImg.onerror = markLoaded;
    fullImg.src = item.fullUrl;
    if (fullImg.complete && fullImg.naturalWidth) markLoaded();
  }
}

function syncSlides() {
  loadSlide(slideEls.prev, allItems[currentViewerIndex - 1], false);
  loadSlide(slideEls.current, allItems[currentViewerIndex], true);
  loadSlide(slideEls.next, allItems[currentViewerIndex + 1], false);
  const cur = allItems[currentViewerIndex];
  viewerCaption.textContent = cur && cur.guestName ? `Shared by ${cur.guestName}` : '';
  updateArrowButtons();
}

function updateArrowButtons() {
  const atStart = currentViewerIndex <= 0;
  const atEnd = currentViewerIndex >= allItems.length - 1;
  viewerPrev.disabled = atStart;
  viewerNext.disabled = atEnd;
  viewerPrevBtn.disabled = atStart;
  viewerNextBtn.disabled = atEnd;
}

function stopAllVideos() {
  viewerTrack.querySelectorAll('.slide-full-video').forEach(v => {
    if (v.getAttribute('src')) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  });
}

function openViewer(index) {
  currentViewerIndex = index;
  resetZoomState();
  viewerTrack.style.transition = '';
  viewerTrack.style.transform = 'translateX(-100%)';
  syncSlides();
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeViewer() {
  viewer.hidden = true;
  document.body.style.overflow = '';
  stopAllVideos();
  resetZoomState();
}

viewerClose.addEventListener('click', closeViewer);

// ---- animated navigation (shared by swipe, arrow buttons, edge nav) ----

let isAnimatingTrack = false;

const TRACK_TRANSITION_MS = 280;

function animateTrackTo(mult, onDone) {
  isAnimatingTrack = true;
  viewerTrack.style.transition = `transform ${TRACK_TRANSITION_MS}ms cubic-bezier(.22,.61,.36,1)`;
  // eslint-disable-next-line no-unused-expressions
  viewerTrack.offsetHeight; // force reflow so the transition applies
  viewerTrack.style.transform = `translateX(${mult * 100}%)`;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    viewerTrack.removeEventListener('transitionend', onEnd);
    clearTimeout(fallbackTimer);
    viewerTrack.style.transition = '';
    isAnimatingTrack = false;
    onDone();
  };
  const onEnd = (e) => {
    if (e && e.target !== viewerTrack) return;
    finish();
  };
  viewerTrack.addEventListener('transitionend', onEnd);
  // Safety net: a backgrounded tab, a dropped frame, or any other reason
  // transitionend fails to fire would otherwise leave the viewer stuck
  // mid-slide forever (wrong photo shown, nav no longer advancing).
  const fallbackTimer = setTimeout(finish, TRACK_TRANSITION_MS + 200);
}

function finalizeNav(delta) {
  currentViewerIndex += delta;
  resetZoomState();
  viewerTrack.style.transform = 'translateX(-100%)';
  syncSlides();
  if (currentViewerIndex >= renderedCount - 5) loadMore();
}

function snapBack() {
  animateTrackTo(-1, () => {});
}

function stepTo(delta) {
  if (isAnimatingTrack) return;
  if (delta < 0 && currentViewerIndex <= 0) return;
  if (delta > 0 && currentViewerIndex >= allItems.length - 1) return;
  animateTrackTo(delta > 0 ? -2 : 0, () => finalizeNav(delta));
}

viewerPrev.addEventListener('click', () => stepTo(-1));
viewerNext.addEventListener('click', () => stepTo(1));
viewerPrevBtn.addEventListener('click', () => stepTo(-1));
viewerNextBtn.addEventListener('click', () => stepTo(1));

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

// ---- pinch-to-zoom + pan + swipe-to-navigate ----
//
// One combined gesture handler on the track: two fingers pinch/pan-zoom
// the *current* slide's full-res media; one finger either pans around a
// zoomed-in photo, or (when not zoomed) drags the whole track to preview
// the neighboring photo sliding in, native-Photos-app style.

let touchMode = null; // 'pinch' | 'pan' | 'swipe' | null
let zoom = 1;
let panX = 0, panY = 0;
let pinchStartDist = 0;
let zoomStart = 1;
let pinchOriginX = 0, pinchOriginY = 0; // pan value at pinch gesture start
let pinchAnchorX = 0, pinchAnchorY = 0; // pinch midpoint minus slide center, at gesture start
let panStartX = 0, panStartY = 0;
let panOriginX = 0, panOriginY = 0;
let dragStartX = 0, dragStartY = 0;
let dragDX = 0;
let dragDY = 0;
let dragAborted = false;
let swipeAxis = null; // null (undecided) | 'x' (nav) | 'y-dismiss' | 'y-ignore'

const SWIPE_AXIS_DEADZONE = 8; // px of movement before we commit to an axis
const DISMISS_THRESHOLD = 120; // px of downward drag that commits to closing
const DISMISS_FADE_DISTANCE = 320; // px of drag over which the backdrop fully fades

function resetZoomState() {
  zoom = 1;
  panX = 0;
  panY = 0;
  touchMode = null;
  const cur = slideEls.current;
  if (cur) {
    const full = cur.querySelector('.slide-full');
    const vid = cur.querySelector('.slide-full-video');
    if (full) full.style.transform = '';
    if (vid) vid.style.transform = '';
  }
}

function getCurrentMediaEl() {
  const item = allItems[currentViewerIndex];
  if (!item) return null;
  return item.isVideo
    ? slideEls.current.querySelector('.slide-full-video')
    : slideEls.current.querySelector('.slide-full');
}

function distance(a, b) {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}
function midpoint(a, b) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function applyZoomTransform() {
  const mediaEl = getCurrentMediaEl();
  const container = slideEls.current;
  if (!mediaEl || !container) return;
  const cw = container.clientWidth || 1;
  const ch = container.clientHeight || 1;
  const nw = mediaEl.naturalWidth || mediaEl.videoWidth || cw;
  const nh = mediaEl.naturalHeight || mediaEl.videoHeight || ch;
  const fit = Math.min(cw / nw, ch / nh);
  const dispW = nw * fit, dispH = nh * fit;
  const scaledW = dispW * zoom, scaledH = dispH * zoom;
  const maxX = Math.max(0, (scaledW - cw) / 2);
  const maxY = Math.max(0, (scaledH - ch) / 2);
  panX = clamp(panX, -maxX, maxX);
  panY = clamp(panY, -maxY, maxY);
  mediaEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function beginPinch(t0, t1) {
  touchMode = 'pinch';
  pinchStartDist = distance(t0, t1) || 1;
  zoomStart = zoom;
  pinchOriginX = panX;
  pinchOriginY = panY;
  const mid = midpoint(t0, t1);
  const rect = slideEls.current.getBoundingClientRect();
  pinchAnchorX = mid.x - (rect.left + rect.width / 2);
  pinchAnchorY = mid.y - (rect.top + rect.height / 2);
}

function updatePinch(t0, t1) {
  const d = distance(t0, t1) || 1;
  const newZoom = clamp(zoomStart * (d / pinchStartDist), 1, 4);
  const mid = midpoint(t0, t1);
  const rect = slideEls.current.getBoundingClientRect();
  const curX = mid.x - (rect.left + rect.width / 2);
  const curY = mid.y - (rect.top + rect.height / 2);
  // Keep the point under the fingers stationary as zoom changes.
  const cx = (pinchAnchorX - pinchOriginX) / zoomStart;
  const cy = (pinchAnchorY - pinchOriginY) / zoomStart;
  zoom = newZoom;
  panX = curX - zoom * cx;
  panY = curY - zoom * cy;
  applyZoomTransform();
}

function endPinch() {
  touchMode = null;
  if (zoom < 1.05) resetZoomState();
}

function beginPan(t) {
  touchMode = 'pan';
  panStartX = t.clientX;
  panStartY = t.clientY;
  panOriginX = panX;
  panOriginY = panY;
}

function updatePan(t) {
  panX = panOriginX + (t.clientX - panStartX);
  panY = panOriginY + (t.clientY - panStartY);
  applyZoomTransform();
}

function endPan() {
  touchMode = null;
}

function beginSwipe(t) {
  touchMode = 'swipe';
  dragStartX = t.clientX;
  dragStartY = t.clientY;
  dragDX = 0;
  dragDY = 0;
  dragAborted = false;
  swipeAxis = null;
  viewerTrack.style.transition = '';
  viewer.style.transition = '';
}

// One finger, not zoomed in: could turn into a horizontal swipe (change
// photo) or a vertical swipe-down (dismiss the viewer). We don't decide
// which until the drag clears a small deadzone, then lock to that axis
// for the rest of the gesture — this is what keeps a diagonal swipe from
// half-triggering both, and keeps a sideways photo-change swipe from ever
// being misread as a dismiss (or vice versa).
function updateSwipe(t) {
  const dx = t.clientX - dragStartX;
  const dy = t.clientY - dragStartY;

  if (swipeAxis === null) {
    if (Math.hypot(dx, dy) < SWIPE_AXIS_DEADZONE) return;
    if (Math.abs(dy) > Math.abs(dx) * 1.3) {
      swipeAxis = dy > 0 ? 'y-dismiss' : 'y-ignore';
    } else {
      swipeAxis = 'x';
    }
  }

  if (swipeAxis === 'x') {
    dragDX = dx;
    let visualDX = dx;
    // Rubber-band at the ends of the list.
    if ((currentViewerIndex <= 0 && dx > 0) || (currentViewerIndex >= allItems.length - 1 && dx < 0)) {
      visualDX = dx * 0.35;
    }
    viewerTrack.style.transform = `translateX(calc(-100% + ${visualDX}px))`;
  } else if (swipeAxis === 'y-dismiss') {
    dragDY = Math.max(0, dy); // only the downward component counts
    const progress = clamp(dragDY / DISMISS_FADE_DISTANCE, 0, 1);
    viewer.style.transform = `translateY(${dragDY}px)`;
    viewer.style.opacity = String(1 - progress * 0.55);
  }
  // 'y-ignore' (swiping up): not a gesture we handle — do nothing and let
  // touchend snap back to rest.
}

function endSwipe() {
  touchMode = null;
  if (swipeAxis === 'y-dismiss') {
    if (dragDY >= DISMISS_THRESHOLD) {
      dismissViewerBySwipe();
    } else {
      snapBackVertical();
    }
    swipeAxis = null;
    return;
  }
  if (swipeAxis !== 'x' || dragAborted) {
    snapBack();
    swipeAxis = null;
    return;
  }
  const width = viewerTrack.clientWidth || 1;
  const threshold = width * 0.18;
  if (dragDX <= -threshold && currentViewerIndex < allItems.length - 1) {
    animateTrackTo(-2, () => finalizeNav(1));
  } else if (dragDX >= threshold && currentViewerIndex > 0) {
    animateTrackTo(0, () => finalizeNav(-1));
  } else {
    snapBack();
  }
  swipeAxis = null;
}

function snapBackVertical() {
  viewer.style.transition = 'transform 220ms ease, opacity 220ms ease';
  viewer.style.transform = '';
  viewer.style.opacity = '';
  setTimeout(() => { viewer.style.transition = ''; }, 240);
}

function dismissViewerBySwipe() {
  viewer.style.transition = 'transform 200ms ease-in, opacity 200ms ease-in';
  viewer.style.transform = 'translateY(100%)';
  viewer.style.opacity = '0';
  setTimeout(() => {
    viewer.style.transition = '';
    viewer.style.transform = '';
    viewer.style.opacity = '';
    closeViewer();
  }, 200);
}

function activeTouches(e) {
  return Array.from(e.touches);
}

viewerTrack.addEventListener('touchstart', e => {
  if (isAnimatingTrack) return;
  const touches = activeTouches(e);
  if (touches.length >= 2) {
    if (touchMode === 'swipe') {
      viewerTrack.style.transition = '';
      viewerTrack.style.transform = 'translateX(-100%)';
    }
    beginPinch(touches[0], touches[1]);
  } else if (touches.length === 1) {
    if (zoom > 1.02) beginPan(touches[0]);
    else beginSwipe(touches[0]);
  }
}, { passive: true });

viewerTrack.addEventListener('touchmove', e => {
  const touches = activeTouches(e);
  if (touchMode === 'pinch' && touches.length >= 2) {
    updatePinch(touches[0], touches[1]);
    e.preventDefault();
  } else if (touchMode === 'pan' && touches.length >= 1) {
    updatePan(touches[0]);
    e.preventDefault();
  } else if (touchMode === 'swipe' && touches.length === 1) {
    updateSwipe(touches[0]);
    e.preventDefault();
  }
}, { passive: false });

viewerTrack.addEventListener('touchend', e => {
  const remaining = activeTouches(e);
  if (touchMode === 'pinch') {
    if (remaining.length === 1) beginPan(remaining[0]);
    else if (remaining.length === 0) endPinch();
  } else if (touchMode === 'pan') {
    if (remaining.length === 0) endPan();
  } else if (touchMode === 'swipe') {
    if (remaining.length === 0) endSwipe();
  }
}, { passive: true });

viewerTrack.addEventListener('touchcancel', () => {
  if (touchMode === 'swipe') {
    if (swipeAxis === 'y-dismiss') snapBackVertical();
    else snapBack();
    swipeAxis = null;
  } else if (touchMode === 'pinch') {
    endPinch();
  }
  touchMode = null;
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
