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
  modalIcon.textContent = '⬆️';
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
  modalIcon.textContent = '⬆️';
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
    modalIcon.textContent = '✅';
    modalTitle.textContent = 'Upload complete!';
    modalFailNote.hidden = true;
    retryFailedBtn.hidden = true;
  } else {
    modalIcon.textContent = '⚠️';
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

async function uploadOnce(task, guestName) {
  const takenAt = await readTakenAt(task.file);
  const thumbBlob = await makeThumbnail(task.file);

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
