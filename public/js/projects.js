function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const grid = document.getElementById('proj-grid');

let _projects = [];
let _sort = localStorage.getItem('msProjSort') || 'alpha-asc';
let _view = localStorage.getItem('msProjView') || 'grid';

// Initialise sort buttons
document.querySelectorAll('[data-sort]').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.sort === _sort);
  btn.addEventListener('click', () => {
    _sort = btn.dataset.sort;
    localStorage.setItem('msProjSort', _sort);
    document.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === _sort));
    renderProjects();
  });
});

// Initialise view buttons
document.querySelectorAll('[data-view]').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.view === _view);
  btn.addEventListener('click', () => {
    _view = btn.dataset.view;
    localStorage.setItem('msProjView', _view);
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === _view));
    renderProjects();
  });
});

function sortProjects(projects) {
  const copy = [...projects];
  switch (_sort) {
    case 'alpha-asc':    return copy.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    case 'alpha-desc':   return copy.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    case 'modified-desc': return copy.sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    case 'modified-asc':  return copy.sort((a, b) => new Date(a.updatedAt ?? 0) - new Date(b.updatedAt ?? 0));
    default: return copy;
  }
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = (Date.now() - new Date(isoStr)) / 1000;
  if (diff < 60)      return 'just now';
  if (diff < 3600)    return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)   return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800)  return `${Math.floor(diff / 86400)}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

function thumbHtml(p, cls = '') {
  if (p.thumbnail?.type === 'video')
    return `<video src="${escHtml(p.thumbnail.url)}" muted autoplay loop playsinline preload="metadata"${cls ? ` class="${cls}"` : ''}></video>`;
  if (p.thumbnail?.type === 'image')
    return `<img src="${escHtml(p.thumbnail.url)}" alt="" loading="lazy"${cls ? ` class="${cls}"` : ''}>`;
  return `<div class="proj-thumb-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round"
        d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18A2.25 2.25 0 0023.25 18V6A2.25 2.25 0 0021 3.75H3A2.25 2.25 0 00.75 6v12A2.25 2.25 0 003 20.25z"/>
    </svg>
    <span>No preview</span>
  </div>`;
}

function attachDelete(el, btn, p) {
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    await fetch(`/api/project/${p.id}`, { method: 'DELETE' });
    _projects = _projects.filter(x => x.id !== p.id);
    renderProjects();
  });
}

function makeCard(p) {
  const card = document.createElement('div');
  card.className = 'proj-card';
  card.dataset.id = p.id;

  const total = p.segmentCount;
  const done  = p.doneCount;
  const pct   = total > 0 ? Math.round(done / total * 100) : 0;
  const meta  = total > 0
    ? `${total} seg${total !== 1 ? 's' : ''} · ${done} done`
    : 'No segments yet';

  card.innerHTML = `
    <div class="proj-thumb-wrap">${thumbHtml(p)}</div>
    <div class="proj-info">
      <div class="proj-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
      <div class="proj-meta">${meta}</div>
      ${total > 0 ? `<div class="proj-progress"><div class="proj-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <button class="proj-delete" title="Delete project" data-id="${p.id}">✕</button>
  `;

  card.addEventListener('click', e => {
    if (e.target.closest('.proj-delete')) return;
    location.href = `/projects/${p.id}`;
  });
  attachDelete(card, card.querySelector('.proj-delete'), p);
  return card;
}

function makeRow(p) {
  const row = document.createElement('div');
  row.className = 'proj-row';
  row.dataset.id = p.id;

  const total    = p.segmentCount;
  const done     = p.doneCount;
  const pct      = total > 0 ? Math.round(done / total * 100) : 0;
  const meta     = total > 0
    ? `${total} seg${total !== 1 ? 's' : ''} · ${done} done`
    : 'No segments yet';
  const modified = relativeTime(p.updatedAt);

  row.innerHTML = `
    <div class="proj-row-thumb">${thumbHtml(p)}</div>
    <div class="proj-row-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
    <div class="proj-row-meta">${meta}</div>
    ${modified ? `<div class="proj-row-modified">${modified}</div>` : ''}
    <div class="proj-row-progress">${total > 0 ? `<div class="proj-row-progress-fill" style="width:${pct}%"></div>` : ''}</div>
    <button class="proj-row-delete" title="Delete project" data-id="${p.id}">✕</button>
  `;

  row.addEventListener('click', e => {
    if (e.target.closest('.proj-row-delete')) return;
    location.href = `/projects/${p.id}`;
  });
  attachDelete(row, row.querySelector('.proj-row-delete'), p);
  return row;
}

function renderProjects() {
  grid.className = `proj-grid${_view === 'list' ? ' view-list' : ''}`;
  grid.innerHTML = '';

  if (!_projects.length) {
    grid.innerHTML = '<div class="proj-empty">No projects yet — click "New Project" to get started.</div>';
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
    const res = await fetch('/api/projects');
    ({ projects: _projects } = await res.json());
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
