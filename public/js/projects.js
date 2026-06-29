function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const grid            = document.getElementById('proj-grid');
const btnShowArchived = document.getElementById('btn-show-archived');
const archivedCount   = document.getElementById('archived-count');

let _projects     = [];
let _sort         = localStorage.getItem('msProjSort') || 'alpha-asc';
const _isMobile   = window.innerWidth < 768;
let _view         = _isMobile ? 'list'  : (localStorage.getItem('msProjView')    || 'grid');
let _preview      = _isMobile ? 'image' : (localStorage.getItem('msProjPreview') || 'video');
let _showArchived = false;

// Sort buttons
document.querySelectorAll('[data-sort]').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.sort === _sort);
  btn.addEventListener('click', () => {
    _sort = btn.dataset.sort;
    localStorage.setItem('msProjSort', _sort);
    document.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === _sort));
    renderProjects();
  });
});

// View buttons
document.querySelectorAll('[data-view]').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.view === _view);
  btn.addEventListener('click', () => {
    _view = btn.dataset.view;
    localStorage.setItem('msProjView', _view);
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === _view));
    renderProjects();
  });
});

// Preview buttons
document.querySelectorAll('[data-preview]').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.preview === _preview);
  btn.addEventListener('click', () => {
    _preview = btn.dataset.preview;
    localStorage.setItem('msProjPreview', _preview);
    document.querySelectorAll('[data-preview]').forEach(b => b.classList.toggle('active', b.dataset.preview === _preview));
    renderProjects();
  });
});

// Archived toggle
btnShowArchived.addEventListener('click', () => {
  _showArchived = !_showArchived;
  btnShowArchived.classList.toggle('active', _showArchived);
  document.querySelector('.pg-section-title').textContent = _showArchived ? 'Archived Projects' : 'All Projects';
  loadProjects();
});

function sortProjects(projects) {
  const copy = [...projects];
  switch (_sort) {
    case 'alpha-asc':     return copy.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    case 'alpha-desc':    return copy.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    case 'modified-desc': return copy.sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    case 'modified-asc':  return copy.sort((a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
    case 'updated-desc':  return copy.sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0) - new Date(a.updatedAt ?? a.createdAt ?? 0));
    default: return copy;
  }
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = (Date.now() - new Date(isoStr)) / 1000;
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

const _emptyThumb = `<div class="proj-thumb-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round"
        d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18A2.25 2.25 0 0023.25 18V6A2.25 2.25 0 0021 3.75H3A2.25 2.25 0 00.75 6v12A2.25 2.25 0 003 20.25z"/>
    </svg>
    <span>No preview</span>
  </div>`;

function thumbHtml(p) {
  if (_preview === 'image') {
    const imgSrc = p.refImage?.url ?? (p.thumbnail?.type === 'image' ? p.thumbnail.url : null);
    if (imgSrc) return `<img src="${escHtml(imgSrc)}" alt="" loading="lazy">`;
    if (p.thumbnail?.type === 'video')
      return `<video src="${escHtml(p.thumbnail.url)}" muted autoplay loop playsinline preload="metadata"></video>`;
    return _emptyThumb;
  }
  // video mode (default)
  if (p.thumbnail?.type === 'video')
    return `<video src="${escHtml(p.thumbnail.url)}" muted autoplay loop playsinline preload="metadata"></video>`;
  const fallbackImg = p.refImage?.url ?? (p.thumbnail?.type === 'image' ? p.thumbnail.url : null);
  if (fallbackImg) return `<img src="${escHtml(fallbackImg)}" alt="" loading="lazy">`;
  return _emptyThumb;
}

const archiveSvg = `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 3a2 2 0 100 4h12a2 2 0 100-4H4zM3 8h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm5 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/></svg>`;
const unarchiveSvg = `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 3a2 2 0 100 4h12a2 2 0 100-4H4zM3 8h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm5 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/></svg>`;

async function toggleArchive(p) {
  const newVal = !_showArchived; // archive when viewing active, unarchive when viewing archived
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: newVal }),
  });
  _projects = _projects.filter(x => x.id !== p.id);
  renderProjects();
  // Refresh archived count badge (only matters when showing active projects)
  if (!_showArchived) refreshArchivedBadge();
}

async function deleteProject(p) {
  if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
  await fetch(`/api/project/${p.id}`, { method: 'DELETE' });
  _projects = _projects.filter(x => x.id !== p.id);
  renderProjects();
  if (!_showArchived) refreshArchivedBadge();
}

async function refreshArchivedBadge() {
  try {
    const res = await fetch('/api/projects');
    const { archivedCount: n } = await res.json();
    if (n > 0) {
      archivedCount.textContent = `(${n})`;
      archivedCount.hidden = false;
    } else {
      archivedCount.hidden = true;
    }
  } catch { /* ignore */ }
}

function makeCard(p) {
  const card = document.createElement('div');
  card.className = 'proj-card';
  card.dataset.id = p.id;

  const total = p.segmentCount;
  const done  = p.doneCount;
  const pct   = total > 0 ? Math.round(done / total * 100) : 0;
  const segLabel      = total > 0 ? `${done}/${total} Segment${total !== 1 ? 's' : ''}` : 'No segments yet';
  const renderedLabel = p.hasRender ? `<span class="proj-meta-rendered">Rendered</span>` : '';

  card.innerHTML = `
    <div class="proj-thumb-wrap">${thumbHtml(p)}</div>
    <div class="proj-info">
      <div class="proj-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
      <div class="proj-meta"><span>${segLabel}</span>${renderedLabel}</div>
      ${total > 0 ? `<div class="proj-progress"><div class="proj-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <button class="proj-archive" title="${_showArchived ? 'Unarchive' : 'Archive'}">${_showArchived ? unarchiveSvg : archiveSvg}</button>
    <button class="proj-delete" title="Delete project" data-id="${p.id}">✕</button>
  `;

  card.addEventListener('click', e => {
    if (e.target.closest('.proj-delete') || e.target.closest('.proj-archive')) return;
    location.href = `/projects/${p.id}`;
  });
  card.querySelector('.proj-archive').addEventListener('click', e => { e.stopPropagation(); toggleArchive(p); });
  card.querySelector('.proj-delete').addEventListener('click', e => { e.stopPropagation(); deleteProject(p); });
  return card;
}

function makeRow(p) {
  const row = document.createElement('div');
  row.className = 'proj-row';
  row.dataset.id = p.id;

  const total    = p.segmentCount;
  const done     = p.doneCount;
  const pct      = total > 0 ? Math.round(done / total * 100) : 0;
  const metaCount = total > 0 ? `${done}/${total}` : '';
  const metaLabel = total > 0 ? ` Segment${total !== 1 ? 's' : ''}` : 'No segments yet';
  const modified = relativeTime(p.updatedAt);

  row.innerHTML = `
    <div class="proj-row-thumb">${thumbHtml(p)}</div>
    <div class="proj-row-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
    <div class="proj-row-meta"><span class="proj-row-meta-count">${metaCount}</span><span class="proj-row-meta-label">${metaLabel}</span></div>
    ${modified ? `<div class="proj-row-modified">${modified}</div>` : ''}
    <div class="proj-row-progress">${total > 0 ? `<div class="proj-row-progress-fill" style="width:${pct}%"></div>` : ''}</div>
    <button class="proj-row-archive" title="${_showArchived ? 'Unarchive' : 'Archive'}">${_showArchived ? unarchiveSvg : archiveSvg}</button>
    <button class="proj-row-delete" title="Delete project" data-id="${p.id}">✕</button>
  `;

  row.addEventListener('click', e => {
    if (e.target.closest('.proj-row-delete') || e.target.closest('.proj-row-archive')) return;
    location.href = `/projects/${p.id}`;
  });
  row.querySelector('.proj-row-archive').addEventListener('click', e => { e.stopPropagation(); toggleArchive(p); });
  row.querySelector('.proj-row-delete').addEventListener('click', e => { e.stopPropagation(); deleteProject(p); });
  return row;
}

function renderProjects() {
  grid.className = `proj-grid${_view === 'list' ? ' view-list' : ''}`;
  grid.innerHTML = '';

  if (!_projects.length) {
    const msg = _showArchived
      ? 'No archived projects.'
      : 'No projects yet — click "New Project" to get started.';
    grid.innerHTML = `<div class="proj-empty">${msg}</div>`;
    return;
  }

  const sorted = sortProjects(_projects);
  for (const p of sorted) {
    grid.appendChild(_view === 'list' ? makeRow(p) : makeCard(p));
  }
}

async function loadProjects() {
  grid.innerHTML = '<div class="proj-loading">Loading…</div>';
  try {
    const url = _showArchived ? '/api/projects?archived=true' : '/api/projects';
    const res = await fetch(url);
    const data = await res.json();
    _projects = data.projects;
    if (!_showArchived && data.archivedCount > 0) {
      archivedCount.textContent = `(${data.archivedCount})`;
      archivedCount.hidden = false;
    } else {
      archivedCount.hidden = true;
    }
  } catch {
    grid.innerHTML = '<div class="proj-empty">Failed to load projects.</div>';
    return;
  }
  renderProjects();
}

document.getElementById('btn-new-project').addEventListener('click', async () => {
  const res = await fetch('/api/project', { method: 'POST' });
  const p   = await res.json();
  location.href = `/projects/${p.id}`;
});

loadProjects();
