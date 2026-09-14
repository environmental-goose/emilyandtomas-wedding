// Task-based batch upload: pick photos, they start uploading immediately,
// progress shown in a modal popup. Each photo uploads as a thumb (client-
// resized JPEG) + the full-res original. EXIF DateTimeOriginal is read
// client-side (when available) and sent along so the gallery can sort by
// when the photo was actually taken, not when it was uploaded.

const guestNameInput = document.getElementById('guestName');
const chooseBtn = document.getElementById('chooseBtn');
const fileInput = document.getElementById('fileInput');

const modal = document.getElementById('uploadModal');
const modalIcon = document.getElementById('modalIcon');
const modalTitle = document.getElementById('modalTitle');
const modalSub = document.getElementById('modalSub');
const modalWarning = document.getElementById('modalWarning');
const modalProgressFill = document.getElementById('modalProgressFill');
const modalFailNote = document.getElementById('modalFailNote');
const modalActions = document.getElementById('modalActions');
const retryFailedBtn = document.getElementById('retryFailedBtn');

const MAX_CONCURRENT = 3;
const THUMB_MAX_DIM = 480;
const THUMB_QUALITY = 0.82;

let tasks = [];
let activeCount = 0;

chooseBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  if (!files.length) return;
  startBatch(files);
});

retryFailedBtn.addEventListener('click', () => {
  tasks.forEach(t => { if (t.status === 'failed') { t.status = 'pending'; t.retried = false; t.progress = 0; } });
  retryFailedBtn.hidden = true;
  modalFailNote.hidden = true;
  modalActions.hidden = true;
  modalIcon.textContent = '↑';
  modalTitle.textContent = 'Uploading photos…';
  modalWarning.hidden = false;
  runQueue();
});

function startBatch(files) {
  tasks = files.map((file, i) => ({
    file,
    id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    progress: 0,
    status: 'pending', // pending | uploading | done | failed
    retried: false,
  }));
  activeCount = 0;
  openModal();
  runQueue();
}

function openModal() {
  modal.hidden = false;
  modalIcon.textContent = '↑';
  modalTitle.textContent = 'Uploading photos…';
  modalWarning.hidden = false;
  modalFailNote.hidden = true;
  modalActions.hidden = true;
  retryFailedBtn.hidden = true;
  updateProgress();
}

function updateProgress() {
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done' || t.status === 'failed').length;
  const overall = total ? tasks.reduce((sum, t) => sum + t.progress, 0) / total : 0;
  modalProgressFill.style.width = `${Math.round(overall * 100)}%`;
  modalSub.textContent = `${done} of ${total} uploaded`;

  if (done === total && total > 0) {
    finishBatch(tasks.filter(t => t.status === 'failed').length);
  }
}

function finishBatch(failedCount) {
  modalWarning.hidden = true;
  modalActions.hidden = false;
  if (failedCount === 0) {
    modalIcon.textContent = '✓';
    modalTitle.textContent = 'Upload complete!';
    modalFailNote.hidden = true;
    retryFailedBtn.hidden = true;
  } else {
    modalIcon.textContent = '!';
    modalTitle.textContent = 'Upload finished with issues';
    modalFailNote.hidden = false;
    modalFailNote.textContent = `${failedCount} photo${failedCount === 1 ? '' : 's'} failed to upload.`;
    retryFailedBtn.hidden = false;
  }
}

function runQueue() {
  while (activeCount < MAX_CONCURRENT) {
    const next = tasks.find(t => t.status === 'pending');
    if (!next) break;
    next.status = 'uploading';
    activeCount++;
    runTask(next).finally(() => {
      activeCount--;
      updateProgress();
      runQueue();
    });
  }
}

function isVideoFile(file) {
  return !!(file.type && file.type.startsWith('video/'));
}

async function readTakenAt(file) {
  try {
    if (window.exifr) {
      const exif = await window.exifr.parse(file, ['DateTimeOriginal']);
      if (exif && exif.DateTimeOriginal instanceof Date && !isNaN(exif.DateTimeOriginal)) {
        return exif.DateTimeOriginal.toISOString();
      }
    }
  } catch (e) {
    // EXIF read failure is non-fatal — just skip takenAt.
  }
  return '';
}

// Videos don't carry EXIF DateTimeOriginal, so fall back to the file's
// own last-modified time (usually close to when it was actually shot) —
// better than defaulting straight to upload time for sort purposes.
function fileLastModifiedIso(file) {
  if (!file.lastModified) return '';
  const d = new Date(file.lastModified);
  return isNaN(d) ? '' : d.toISOString();
}

async function uploadOnce(task, guestName) {
  const video = isVideoFile(task.file);
  // EXIF is the authoritative source for photos (it's the actual moment
  // the shutter opened, independent of any later file copy/export), but
  // fall back to the file's own last-modified time when EXIF is missing
  // (non-EXIF formats, screenshots, etc.) rather than leaving takenAt
  // blank and letting the photo sort by upload time instead.
  const takenAt = video
    ? fileLastModifiedIso(task.file)
    : (await readTakenAt(task.file)) || fileLastModifiedIso(task.file);

  let thumbBlob;
  if (video) {
    try {
      thumbBlob = await makeVideoThumbnail(task.file);
    } catch (e) {
      thumbBlob = await makeVideoFallbackThumbnail();
    }
  } else {
    thumbBlob = await makeThumbnail(task.file);
  }

  await uploadPart('thumb', thumbBlob, task.id, guestName, task.file.name, takenAt, frac => {
    task.progress = frac * 0.35;
    updateProgress();
  });
  await uploadPart('full', task.file, task.id, guestName, task.file.name, takenAt, frac => {
    task.progress = 0.35 + frac * 0.65;
    updateProgress();
  });
}

async function runTask(task) {
  const guestName = (guestNameInput.value || 'Anonymous').trim() || 'Anonymous';
  try {
    await uploadOnce(task, guestName);
    task.progress = 1;
    task.status = 'done';
  } catch (e) {
    if (!task.retried) {
      task.retried = true;
      task.progress = 0;
      try {
        await uploadOnce(task, guestName);
        task.progress = 1;
        task.status = 'done';
        return;
      } catch (e2) {
        // fall through to failed
      }
    }
    task.status = 'failed';
    task.progress = 1;
  }
}

function makeThumbnail(file) {
  return new Promise((resolve, reject) => {
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .then(bitmap => {
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('thumbnail encode failed'));
        }, 'image/jpeg', THUMB_QUALITY);
      })
      .catch(reject);
  });
}

// Video thumbnail: decode a frame shortly into the clip via a hidden
// <video> element, then draw it to canvas. Frame 0 is often solid
// black/undecoded, so we nudge forward a little first — but a stalled
// 'seeked' event (it doesn't reliably fire for every codec/container)
// no longer means giving up on a real frame entirely: if it hasn't
// fired within seekTimeoutMs we just capture whatever's already on
// screen instead, which is still far better than the generic fallback
// tile. Only a genuine load failure (or nothing decodable within the
// overall timeout) falls all the way back to makeVideoFallbackThumbnail.
//
// The element is deliberately attached to the document (off-screen, not
// display:none) instead of left detached — Safari in particular can
// fail to ever fire 'loadeddata'/'seeked' on a <video> that was never
// inserted into the page, which is what was silently sending most real
// guest uploads (mobile Safari) straight to the fallback tile.
function makeVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    videoEl.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:2px; height:2px; opacity:0.01; pointer-events:none;';
    document.body.appendChild(videoEl);
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (err, blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(seekTimer);
      URL.revokeObjectURL(objectUrl);
      videoEl.remove();
      if (err) reject(err); else resolve(blob);
    };

    const captureNow = () => {
      try {
        // Don't fall back to THUMB_MAX_DIM here — that used to mask a
        // video element with no decoded frame yet (videoWidth/Height
        // both 0) by drawing its still-blank canvas as if it were a
        // real capture, instead of correctly failing over to
        // makeVideoFallbackThumbnail.
        const w = videoEl.videoWidth, h = videoEl.videoHeight;
        if (!w || !h) { finish(new Error('no video dimensions')); return; }
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (blob) finish(null, blob);
          else finish(new Error('video frame encode failed'));
        }, 'image/jpeg', THUMB_QUALITY);
      } catch (e) {
        finish(e);
      }
    };

    const overallTimer = setTimeout(() => finish(new Error('video thumbnail timed out')), 8000);
    let seekTimer;

    videoEl.addEventListener('loadeddata', () => {
      try {
        videoEl.currentTime = Math.min(0.2, (videoEl.duration || 1) / 2);
      } catch (e) {
        captureNow();
        return;
      }
      seekTimer = setTimeout(captureNow, 1500);
      videoEl.addEventListener('seeked', () => {
        clearTimeout(seekTimer);
        captureNow();
      }, { once: true });
    });
    videoEl.addEventListener('error', () => finish(new Error('video load error')));

    videoEl.src = objectUrl;
  });
}

// Generic placeholder (plain dark tile) used when a real video frame
// can't be captured — keeps the gallery grid consistent instead of
// leaving a broken thumbnail. Deliberately has no play glyph baked into
// the pixels: the gallery/admin grids already overlay their own video
// badge on top of every video thumbnail, so drawing one here as well
// used to produce two overlapping video symbols whenever this fallback
// was the one that got used.
function makeVideoFallbackThumbnail() {
  return new Promise(resolve => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2E241C';
    ctx.fillRect(0, 0, 320, 320);
    canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.8);
  });
}

function uploadPart(kind, blob, id, guestName, originalName, takenAt, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('kind', kind);
    formData.append('id', id);
    formData.append('guestName', guestName);
    formData.append('originalName', originalName);
    if (takenAt) formData.append('takenAt', takenAt);
    formData.append('file', blob, kind === 'thumb' ? 'thumb.jpg' : (originalName || 'photo.jpg'));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
}
