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

  // ---- Minimal in-house ZIP writer (store/uncompressed only) ----
  //
  // This used to be a third-party library (fflate, loaded from cdnjs) —
  // cdnjs has since dropped the package entirely (the script tag 404s),
  // which silently broke every download. Photos/videos are already-
  // compressed formats, so all this ever needed was ZIP's plain "stored"
  // method: a per-file header with the real CRC-32/size (known upfront
  // since every file is already fully in memory by the time this runs),
  // the raw bytes, then a central directory + EOCD record at the end.
  // No compression, no external dependency.
  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  // files: { "name.jpg": Uint8Array, ... } -> a complete ZIP as Uint8Array
  function buildZipStore(files) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const name of Object.keys(files)) {
      const bytes = files[name];
      const nameBytes = enc.encode(name);
      const crc = crc32(bytes);

      const header = new Uint8Array(30 + nameBytes.length);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, 0x04034b50, true);  // local file header signature
      hv.setUint16(4, 20, true);          // version needed to extract
      hv.setUint16(6, 0, true);           // flags
      hv.setUint16(8, 0, true);           // compression method: stored
      hv.setUint16(10, time, true);
      hv.setUint16(12, date, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, bytes.length, true);
      hv.setUint32(22, bytes.length, true);
      hv.setUint16(26, nameBytes.length, true);
      hv.setUint16(28, 0, true);          // extra field length
      header.set(nameBytes, 30);

      central.push({ nameBytes, crc, size: bytes.length, localHeaderOffset: offset });

      parts.push(header);
      offset += header.length;
      parts.push(bytes);
      offset += bytes.length;
    }

    const centralStart = offset;
    for (const entry of central) {
      const header = new Uint8Array(46 + entry.nameBytes.length);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, 0x02014b50, true);  // central directory file header signature
      hv.setUint16(4, 20, true);          // version made by
      hv.setUint16(6, 20, true);          // version needed to extract
      hv.setUint16(8, 0, true);           // flags
      hv.setUint16(10, 0, true);          // compression method: stored
      hv.setUint16(12, time, true);
      hv.setUint16(14, date, true);
      hv.setUint32(16, entry.crc, true);
      hv.setUint32(20, entry.size, true);
      hv.setUint32(24, entry.size, true);
      hv.setUint16(28, entry.nameBytes.length, true);
      hv.setUint16(30, 0, true);          // extra field length
      hv.setUint16(32, 0, true);          // file comment length
      hv.setUint16(34, 0, true);          // disk number start
      hv.setUint16(36, 0, true);          // internal file attributes
      hv.setUint32(38, 0x81a40000, true); // external file attributes: unix -rw-r--r--
      hv.setUint32(42, entry.localHeaderOffset, true);
      header.set(entry.nameBytes, 46);
      parts.push(header);
      offset += header.length;
    }
    const centralSize = offset - centralStart;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);   // end of central directory signature
    ev.setUint16(4, 0, true);            // disk number
    ev.setUint16(6, 0, true);            // disk where central directory starts
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);           // comment length
    parts.push(eocd);
    offset += eocd.length;

    const out = new Uint8Array(offset);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  const FETCH_CONCURRENCY = 4;

  // Fetch one file's bytes, retrying once on any failure (network blip,
  // a dropped connection on a big video, etc.) before giving up on it.
  async function fetchBytesWithRetry(url, attempts) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // Fetch every selected item's bytes with a small concurrency pool
  // (instead of one-at-a-time) so a 20+ file batch doesn't take forever,
  // and keep going past individual failures rather than aborting the
  // whole batch on the first bad file.
  async function fetchAllWithConcurrency(selItems, concurrency, onProgress) {
    const results = new Array(selItems.length).fill(null);
    const failed = [];
    let nextIndex = 0;
    let doneCount = 0;

    async function worker() {
      for (;;) {
        const i = nextIndex++;
        if (i >= selItems.length) return;
        try {
          results[i] = await fetchBytesWithRetry(selItems[i].fullUrl, 2);
        } catch (e) {
          failed.push(selItems[i]);
        }
        doneCount++;
        onProgress(doneCount, selItems.length);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, selItems.length) }, worker);
    await Promise.all(workers);
    return { results, failed };
  }

  downloadBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    downloadBtn.disabled = true;
    const originalText = downloadBtn.textContent;
    try {
      const ids = Array.from(selected);
      const selItems = ids.map(id => items.find(it => it.id === id)).filter(Boolean);

      const { results, failed } = await fetchAllWithConcurrency(selItems, FETCH_CONCURRENCY, (done, total) => {
        downloadBtn.textContent = 'Fetching ' + done + '/' + total + '…';
      });

      if (failed.length) {
        const okCount = selItems.length - failed.length;
        const proceed = okCount > 0 && confirm(
          failed.length + ' of ' + selItems.length + ' file(s) failed to download. ' +
          'Continue and zip the ' + okCount + ' that succeeded?'
        );
        if (!proceed) {
          downloadBtn.disabled = false;
          downloadBtn.textContent = originalText;
          return;
        }
      }

      const files = {};
      selItems.forEach((item, i) => {
        if (!results[i]) return;
        const ext = (item.fullUrl.split('.').pop() || 'jpg').toLowerCase();
        const safeName = (item.guestName || 'photo').replace(/[^a-z0-9-_]+/gi, '_');
        files[safeName + '_' + item.id.slice(0, 8) + '.' + ext] = results[i];
      });

      downloadBtn.textContent = 'Zipping…';
      // Photos and videos are already-compressed formats, so this only
      // ever writes ZIP "stored" (uncompressed) entries — no DEFLATE, no
      // third-party zip library needed (cdnjs quietly dropped fflate;
      // relying on it here was a single point of failure for the whole
      // feature). buildZipStore runs entirely in this tab, on the
      // admin's own CPU, which has no equivalent of the Worker's CPU
      // time limit that made the server-side version fail on anything
      // but a tiny selection.
      const zipped = buildZipStore(files);

      const blob = new Blob([zipped], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wedding-photos.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      alert('Download failed — try again, maybe with fewer photos selected.');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  });
})();
