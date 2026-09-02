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
        '<img src="' + item.thumbUrl + '" loading="lazy" decoding="async" alt="">';
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

  downloadBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    downloadBtn.disabled = true;
    const originalText = downloadBtn.textContent;
    try {
      const ids = Array.from(selected);
      const files = {};
      for (let i = 0; i < ids.length; i++) {
        downloadBtn.textContent = 'Fetching ' + (i + 1) + '/' + ids.length + '…';
        const item = items.find(it => it.id === ids[i]);
        const res = await fetch(item.fullUrl);
        const buf = new Uint8Array(await res.arrayBuffer());
        const safeName = (item.guestName || 'photo').replace(/[^a-z0-9-_]+/gi, '_');
        files[safeName + '_' + item.id.slice(0, 8) + '.jpg'] = buf;
      }
      downloadBtn.textContent = 'Zipping…';
      const zipped = fflate.zipSync(files, { level: 6 });
      const blob = new Blob([zipped], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wedding-photos.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Download failed — try again, maybe with fewer photos selected.');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  });
})();
