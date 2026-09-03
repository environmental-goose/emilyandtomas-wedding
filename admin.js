(function () {
  const PASSWORD_KEY = 'wedding_admin_pw';
  const gate = document.getElementById('gate');
  const panel = document.getElementById('adminPanel');
  const passwordInput = document.getElementById('passwordInput');
  const unlockBtn = document.getElementById('unlockBtn');
  const gateError = document.getElementById('gateError');
  const grid = document.getElementById('adminGrid');
  const emptyState = document.getElementById('adminEmpty');
  const selectAllCb = document.getElementById('selectAll');
  const selectionCount = document.getElementById('selectionCount');
  const downloadBtn = document.getElementById('downloadBtn');
  const deleteBtn = document.getElementById('deleteBtn');

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
    }
  });

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
      // Photos and videos are already-compressed formats — running them
      // through DEFLATE (the old level:6) bought almost no size reduction
      // while costing real time and blocking the tab. Store-only (level 0)
      // via the async API is dramatically faster and doesn't freeze the UI.
      const zipped = await new Promise((resolve, reject) => {
        fflate.zip(files, { level: 0 }, (err, data) => {
          if (err) reject(err); else resolve(data);
        });
      });

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
