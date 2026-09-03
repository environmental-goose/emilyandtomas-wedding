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
  const takenAt = video ? fileLastModifiedIso(task.file) : await readTakenAt(task.file);

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

// Video thumbnail: decode a frame a moment into the clip (frame 0 is
// sometimes black/undecoded) via a hidden <video> element, then draw it
// to canvas exactly like the photo thumbnail path. Bounded by a timeout
// since seek/decode timing is inconsistent across browsers — on any
// failure the caller falls back to makeVideoFallbackThumbnail so the
// gallery always has something to show.
function makeVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.preload = 'metadata';
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (err, blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      videoEl.remove();
      if (err) reject(err); else resolve(blob);
    };

    const timer = setTimeout(() => finish(new Error('video thumbnail timed out')), 8000);

    videoEl.addEventListener('loadeddata', () => {
      try {
        videoEl.currentTime = Math.min(0.2, (videoEl.duration || 1) / 2);
      } catch (e) {
        finish(e);
      }
    });
    videoEl.addEventListener('seeked', () => {
      try {
        const w = videoEl.videoWidth || THUMB_MAX_DIM;
        const h = videoEl.videoHeight || THUMB_MAX_DIM;
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
    });
    videoEl.addEventListener('error', () => finish(new Error('video load error')));

    videoEl.src = objectUrl;
  });
}

// Generic placeholder (dark tile + play glyph) used when a real video
// frame can't be captured — keeps the gallery grid consistent instead of
// leaving a broken thumbnail.
function makeVideoFallbackThumbnail() {
  return new Promise(resolve => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2E241C';
    ctx.fillRect(0, 0, 320, 320);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(160, 160, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#2E241C';
    ctx.beginPath();
    ctx.moveTo(146, 138);
    ctx.lineTo(146, 182);
    ctx.lineTo(186, 160);
    ctx.closePath();
    ctx.fill();
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
