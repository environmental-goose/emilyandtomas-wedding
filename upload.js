(function () {
  const MAX_CONCURRENT = 3;
  const MAX_FILE_BYTES = 60 * 1024 * 1024; // 60MB safety cap

  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const fileListEl = document.getElementById('fileList');
  const guestNameInput = document.getElementById('guestName');

  function getGuestName() {
    const v = guestNameInput.value.trim();
    return v || 'Anonymous';
  }

  fileInput.addEventListener('change', () => handleFiles(fileInput.files));
  ['dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });

  let queue = [];
  let running = 0;

  function handleFiles(fileListObj) {
    const files = Array.from(fileListObj).filter(f => f.type.startsWith('image/'));
    files.forEach(file => {
      if (file.size > MAX_FILE_BYTES) {
        addRow(file, { skip: true, reason: 'Too large (60MB max)' });
        return;
      }
      const id = crypto.randomUUID();
      const row = addRow(file, { id });
      queue.push({ id, file, row });
    });
    fileInput.value = '';
    pump();
  }

  function addRow(file, { id, skip, reason } = {}) {
    const li = document.createElement('li');
    li.className = 'file-row';
    li.dataset.id = id || '';
    li.innerHTML =
      '<img class="file-thumb" alt="">' +
      '<div class="file-info">' +
        '<div class="file-name">' + escapeHtml(file.name) + '</div>' +
        '<div class="progress-track"><div class="progress-fill"></div></div>' +
      '</div>' +
      '<div class="file-status">' + (skip ? reason : 'Queued') + '</div>';
    fileListEl.prepend(li);
    if (!skip) {
      const img = li.querySelector('.file-thumb');
      const url = URL.createObjectURL(file);
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
    } else {
      li.querySelector('.file-status').classList.add('error');
    }
    return li;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      const task = queue.shift();
      running++;
      runTask(task).finally(() => { running--; pump(); });
    }
  }

  async function runTask({ id, file, row }, isRetry = false) {
    const statusEl = row.querySelector('.file-status');
    const fillEl = row.querySelector('.progress-fill');
    const guestName = getGuestName();
    statusEl.classList.remove('error');
    statusEl.textContent = isRetry ? 'Retrying…' : 'Preparing…';

    try {
      const thumbBlob = await makeThumbnail(file).catch(() => null);
      statusEl.textContent = 'Uploading…';

      await uploadPart('thumb', thumbBlob || file, id, guestName, file.name);
      await uploadPart('full', file, id, guestName, file.name, pct => {
        fillEl.style.width = Math.round(pct * 100) + '%';
      });

      fillEl.style.width = '100%';
      statusEl.textContent = 'Done ✓';
    } catch (err) {
      if (!isRetry) {
        return runTask({ id, file, row }, true);
      }
      statusEl.textContent = 'Failed — ';
      statusEl.classList.add('error');
      const retryBtn = document.createElement('button');
      retryBtn.className = 'retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.onclick = () => {
        retryBtn.remove();
        queue.push({ id, file, row });
        pump();
      };
      statusEl.appendChild(retryBtn);
    }
  }

  async function makeThumbnail(file, maxDim = 480, quality = 0.82) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  }

  function uploadPart(kind, blob, id, guestName, originalName, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('id', id);
      fd.append('guestName', guestName);
      fd.append('originalName', originalName);
      fd.append('file', blob, kind + '.jpg');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = e => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('HTTP ' + xhr.status));
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(fd);
    });
  }
})();
