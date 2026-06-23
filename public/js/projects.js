function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const grid = document.getElementById('proj-grid');

async function loadProjects() {
  let projects;
  try {
    const res = await fetch('/api/projects');
    ({ projects } = await res.json());
  } catch {
    grid.innerHTML = '<div class="proj-empty">Failed to load projects.</div>';
    return;
  }

  grid.innerHTML = '';

  if (!projects.length) {
    grid.innerHTML = '<div class="proj-empty">No projects yet — click "New Project" to get started.</div>';
    return;
  }

  for (const p of projects) {
    grid.appendChild(makeCard(p));
  }
}

function makeCard(p) {
  const card = document.createElement('div');
  card.className = 'proj-card';
  card.dataset.id = p.id;

  let thumbHtml;
  if (p.thumbnail?.type === 'video') {
    thumbHtml = `<video src="${escHtml(p.thumbnail.url)}" muted autoplay loop playsinline preload="metadata"></video>`;
  } else if (p.thumbnail?.type === 'image') {
    thumbHtml = `<img src="${escHtml(p.thumbnail.url)}" alt="" loading="lazy">`;
  } else {
    thumbHtml = `
      <div class="proj-thumb-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18A2.25 2.25 0 0023.25 18V6A2.25 2.25 0 0021 3.75H3A2.25 2.25 0 00.75 6v12A2.25 2.25 0 003 20.25z"/>
        </svg>
        <span>No preview</span>
      </div>`;
  }

  const total = p.segmentCount;
  const done  = p.doneCount;
  const pct   = total > 0 ? Math.round(done / total * 100) : 0;
  const meta  = total > 0
    ? `${total} seg${total !== 1 ? 's' : ''} · ${done} done`
    : 'No segments yet';

  card.innerHTML = `
    <div class="proj-thumb-wrap">${thumbHtml}</div>
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

  card.querySelector('.proj-delete').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    await fetch(`/api/project/${p.id}`, { method: 'DELETE' });
    card.remove();
    if (!grid.querySelector('.proj-card')) {
      grid.innerHTML = '<div class="proj-empty">No projects yet — click "New Project" to get started.</div>';
    }
  });

  return card;
}

document.getElementById('btn-new-project').addEventListener('click', async () => {
  const res = await fetch('/api/project', { method: 'POST' });
  const p   = await res.json();
  location.href = `/projects/${p.id}`;
});

loadProjects();
