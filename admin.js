(function () {
  const PASSWORD_KEY = 'wedding_admin_pw';
  const gate = document.getElementById('gate');
  const panel = document.getElementById('adminPanel');
  const passwordInput = document.getElementById('passwordInput');
  const unlockBtn = document.getElementById('unlockBtn');
  const gateError = document.getElementById('gateError');
  const grid = document.getElementById('adminGrid');
  const storageUsageEl = document.getElementById('storageUsage');
  const emptyState = document.getElementById('adminEmpty');
  const selectAllCb = document.getElementById('selectAll');
  const selectionCount = document.getElementById('selectionCount');
  const downloadBtn = document.getElementById('downloadBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const fixThumbsBtn = document.getElementById('fixThumbsBtn');

  let password = sessionStorage.getItem(PASSWORD_KEY) || '';
  let items = [];
  let selected = new Set();

  async function verify(pw) {
    const res = await fetch('/api/admin/verify', { headers: { 'X-Admin-Password': pw } });
    return res.ok;
  }

  async function tryUnlock(pw) {
    if (!pw) return;
    const ok = await verify(pw);
    if (ok) {
      password = pw;
      sessionStorage.setItem(PASSWORD_KEY, pw);
      gateError.hidden = true;
      gate.hidden = true;
      panel.hidden = false;
      loadPhotos();
      loadStorageUsage();
    } else {
      gateError.hidden = false;
    }
  }

  unlockBtn.addEventListener('click', () => tryUnlock(passwordInput.value));
  passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(passwordInput.value); });

  if (password) tryUnlock(password);

  async function loadPhotos() {
    const res = await fetch('/api/photos?limit=1000');
    const data = await res.json();
    items = data.items || [];
    selected.clear();
    render();
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return (i === 0 ? value : value.toFixed(value < 10 ? 2 : 1)) + ' ' + units[i];
  }

  async function loadStorageUsage() {
    try {
      const res = await fetch('/api/admin/storage-usage', { headers: { 'X-Admin-Password': password } });
      if (!res.ok) throw new Error('storage-usage failed');
      const data = await res.json();
      storageUsageEl.textContent = formatBytes(data.totalBytes) + ' used across ' + data.objectCount + ' files';
    } catch (e) {
      storageUsageEl.textContent = '';
    }
  }

  // ---- Video thumbnail auto-repair ----
  // Guest phones generate video thumbnails client-side at upload time
  // (see upload.js), but that decode-a-frame-from-a-<video>-element trick
  // is inherently unreliable across the wide range of real phone codecs
  // and mobile-browser quirks — when it fails, the upload silently keeps
  // a plain flat-color placeholder image instead. This runs in a normal
  // desktop browser (wherever admin is open), which reliably can decode
  // these videos, and replaces any placeholder-flat thumbnail with a real
  // captured frame. Safe to re-run any time — it only touches thumbnails
  // that are still flat, so already-fixed ones are left alone.
  function isFlatImageData(data) {
    const r0 = data[0], g0 = data[1], b0 = data[2];
    // Sample every ~100th pixel rather than every single one — plenty to
    // tell a real photo (lots of variation) apart from a solid-color fill.
    for (let i = 4; i < data.length; i += 4 * 97) {
      if (Math.abs(data[i] - r0) > 3 || Math.abs(data[i + 1] - g0) > 3 || Math.abs(data[i + 2] - b0) > 3) {
        return false;
      }
    }
    return true;
  }

  function isBrokenVideoThumb(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          resolve(isFlatImageData(data));
        } catch (e) {
          resolve(false);
        }
      };
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  // Decode the video's first frame via a hidden <video> element. Frame 0
  // is often solid black/undecoded, so this nudges forward slightly
  // first — but a stalled 'seeked' event (it doesn't reliably fire for
  // every codec/container) just means capturing whatever's already on
  // screen after a short wait, rather than failing outright.
  //
  // The element is deliberately attached to the document (off-screen,
  // not display:none) rather than left detached — Safari in particular
  // can fail to ever fire 'loadeddata'/'seeked' on a <video> that was
  // never inserted into the page, which is what made this silently fail
  // for most videos when run from a non-Chromium browser.
  function captureVideoFrameFromUrl(url) {
    return new Promise((resolve, reject) => {
      const videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.preload = 'auto';
      videoEl.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:2px; height:2px; opacity:0.01; pointer-events:none;';
      document.body.appendChild(videoEl);
      let settled = false;

      const finish = (err, blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        clearTimeout(seekTimer);
        videoEl.removeAttribute('src');
        videoEl.load();
        videoEl.remove();
        if (err) reject(err); else resolve(blob);
      };

      const captureNow = () => {
        try {
          const w = videoEl.videoWidth, h = videoEl.videoHeight;
          if (!w || !h) { finish(new Error('no video dimensions (readyState=' + videoEl.readyState + ')')); return; }
          const MAX_DIM = 480;
          const scale = Math.min(1, MAX_DIM / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => {
            if (blob) finish(null, blob); else finish(new Error('encode failed'));
          }, 'image/jpeg', 0.82);
        } catch (e) {
          finish(e);
        }
      };

      const overallTimer = setTimeout(() => {
        finish(new Error('video load timed out (readyState=' + videoEl.readyState + ', networkState=' + videoEl.networkState + ')'));
      }, 20000);
      let seekTimer;

      videoEl.addEventListener('loadeddata', () => {
        try {
          videoEl.currentTime = Math.min(0.2, (videoEl.duration || 1) / 2);
        } catch (e) {
          captureNow();
          return;
        }
        seekTimer = setTimeout(captureNow, 2000);
        videoEl.addEventListener('seeked', () => { clearTimeout(seekTimer); captureNow(); }, { once: true });
      });
      videoEl.addEventListener('error', () => {
        const err = videoEl.error;
        finish(new Error('video load error (code=' + (err && err.code) + ')'));
      });

      videoEl.src = url;
    });
  }

  async function uploadThumbOverwrite(id, blob, guestName, originalName, takenAt) {
    const fd = new FormData();
    fd.append('kind', 'thumb');
    fd.append('id', id);
    fd.append('guestName', guestName);
    fd.append('originalName', originalName);
    if (takenAt) fd.append('takenAt', takenAt);
    fd.append('file', blob, 'thumb.jpg');
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('thumb upload failed: ' + res.status);
  }

  fixThumbsBtn.addEventListener('click', async () => {
    fixThumbsBtn.disabled = true;
    const originalText = fixThumbsBtn.textContent;
    try {
      const videos = items.filter(i => i.isVideo);
      let checked = 0, fixed = 0;
      const errors = [];
      for (const v of videos) {
        checked++;
        fixThumbsBtn.textContent = 'Checking ' + checked + '/' + videos.length + '…';
        const cacheBustUrl = v.thumbUrl + (v.thumbUrl.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        let broken = false;
        try {
          broken = await isBrokenVideoThumb(cacheBustUrl);
        } catch (e) {
          broken = false;
        }
        if (!broken) continue;
        fixThumbsBtn.textContent = 'Fixing ' + checked + '/' + videos.length + '…';
        // One retry — a stalled decode/seek on the first attempt
        // sometimes just clears up on a fresh <video> element.
        let lastErr = null;
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            const blob = await captureVideoFrameFromUrl(v.fullUrl);
            await uploadThumbOverwrite(v.id, blob, v.guestName, v.originalName, v.takenAt);
            ok = true;
          } catch (e) {
            lastErr = e;
          }
        }
        if (ok) {
          fixed++;
        } else {
          errors.push(v.originalName + ': ' + String(lastErr && lastErr.message || lastErr));
        }
      }
      if (fixed > 0) {
        await loadPhotos();
        loadStorageUsage();
      }
      let msg = 'Checked ' + videos.length + ' video(s). Fixed ' + fixed + '.';
      if (errors.length) {
        msg += '\n\n' + errors.length + ' still failed:\n' + errors.slice(0, 6).join('\n');
        if (errors.length > 6) msg += '\n…and ' + (errors.length - 6) + ' more.';
      }
      alert(msg);
    } catch (e) {
      alert('Video thumbnail fix failed — try again. (' + String(e && e.message || e) + ')');
    } finally {
      fixThumbsBtn.disabled = false;
      fixThumbsBtn.textContent = originalText;
    }
  });

  function render() {
    grid.innerHTML = '';
    emptyState.hidden = items.length > 0;
    items.forEach(item => {
      const cell = document.createElement('div');
      cell.className = 'admin-cell';
      cell.innerHTML =
        '<label class="admin-check"><input type="checkbox"></label>' +
        '<img src="' + item.thumbUrl + '" loading="lazy" decoding="async" alt="">' +
        (item.isVideo ? '<span class="grid-item-video-badge"><svg viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>' : '');
      const cb = cell.querySelector('input');
      cb.checked = selected.has(item.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(item.id); else selected.delete(item.id);
        updateToolbar();
      });
      grid.appendChild(cell);
    });
    updateToolbar();
  }

  function updateToolbar() {
    selectionCount.textContent = selected.size + ' selected';
    downloadBtn.disabled = selected.size === 0;
    deleteBtn.disabled = selected.size === 0;
    selectAllCb.checked = selected.size > 0 && selected.size === items.length;
  }

  selectAllCb.addEventListener('change', () => {
    if (selectAllCb.checked) items.forEach(i => selected.add(i.id));
    else selected.clear();
    render();
  });

  deleteBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!confirm('Delete ' + selected.size + ' photo(s)? This cannot be undone.')) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      const res = await fetch('/api/admin/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) throw new Error('Delete failed');
      await loadPhotos();
    } catch (e) {
      alert('Delete failed — try again.');
    } finally {
      deleteBtn.textContent = 'Delete';
      loadStorageUsage();
    }
  });

  // The ZIP itself is now assembled server-side (see worker/index.js) —
  // the Worker streams it straight out of R2 as it reads, instead of
  // this page fetching every full-res file into memory and re-encoding
  // them into one big Blob before anything could be saved. This just
  // hands the Worker the selected ids and lets the browser's native
  // download handling take it from there, which is also what gives the
  // user a real OS/browser download-progress indicator instead of a
  // frozen tab.
  downloadBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    downloadBtn.disabled = true;
    const originalText = downloadBtn.textContent;
    try {
      const ids = Array.from(selected);
      downloadBtn.textContent = 'Preparing…';
      const res = await fetch('/api/admin/prepare-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error('prepare failed: ' + res.status);
      const { token } = await res.json();
      // A plain navigation (not fetch) so the browser treats the
      // Content-Disposition: attachment response as a real download —
      // handled by its own download manager — rather than something
      // this page has to buffer and save itself. The response headers
      // mean the current page is never actually left.
      window.location.href = '/api/admin/download-zip?token=' + encodeURIComponent(token);
    } catch (e) {
      alert('Download failed — try again, maybe with fewer photos selected.');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  });
})();
