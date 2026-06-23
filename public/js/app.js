import { state } from './state.js';
import { timelineSetProject, timelineSetJobs, timelineClearSelection, timelineRedraw, getFrameInfo } from './timeline.js';
import { playerBuildPlaylist, playerSeek, playerToggleGenSeg } from './player.js';

// Per-segment overlay visibility — read by timeline.js draw to dim hidden segments
window._hiddenGenSegIds = new Set();

// ── Project init ───────────────────────────────────────────────
async function initProject() {
  // URL takes priority: /projects/:id
  const urlMatch = location.pathname.match(/^\/projects\/([^/]+)$/);
  const urlId    = urlMatch?.[1] ?? null;
  const stored   = urlId || localStorage.getItem('motionStudioProjectId');

  if (stored) {
    try {
      const res = await fetch(`/api/project/${stored}`);
      if (res.ok) {
        state.project = await res.json();
        localStorage.setItem('motionStudioProjectId', state.project.id);
        if (!urlId) history.replaceState(null, '', `/projects/${state.project.id}`);
        applyProject();
        await restoreJobs();
        return;
      }
    } catch (err) { console.error('[initProject] failed to load stored project:', err); }
  }

  // Before creating a fresh project, reuse any existing empty untitled one
  try {
    const listRes = await fetch('/api/projects');
    if (listRes.ok) {
      const { projects } = await listRes.json();
      const empty = projects.find(p =>
        (!p.name || p.name === 'untitled') && p.clipCount === 0 && p.segmentCount === 0
      );
      if (empty) {
        localStorage.setItem('motionStudioProjectId', empty.id);
        location.href = `/projects/${empty.id}`;
        return;
      }
    }
  } catch { /* fall through to create */ }

  const res = await fetch('/api/project', { method: 'POST' });
  state.project = await res.json();
  localStorage.setItem('motionStudioProjectId', state.project.id);
  location.href = `/projects/${state.project.id}`;
}

async function restoreJobs() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) return;
    const { jobs } = await res.json();
    // Render oldest first so newest ends up on top (prepend reverses order)
    jobs.forEach(job => watchJob(job));
  } catch { /* ignore */ }
}

let _applyingProject = false;

function applyProject() {
  const p = state.project;
  _applyingProject = true;
  setHeaderName(p.name || 'untitled');
  document.getElementById('project-name').value = p.name || 'untitled';
  // Sync settings panel fields (_applyingProject guard prevents re-saving on load)
  const gfpsEl = document.getElementById('gen-fps');
  if (gfpsEl) gfpsEl.value = String(p.genFps ?? 24);
  const gfrmEl = document.getElementById('gen-frames-per-segment');
  if (gfrmEl) gfrmEl.value = String(p.genFramesPerSegment ?? 81);
  const modeEl = document.getElementById('gen-mode');
  if (modeEl) modeEl.value = p.mode ?? 'subject-replacement';
  const arEl = document.getElementById('aspect-ratio');
  if (arEl) arEl.value = p.aspectRatio ?? '9:16';
  const dpEl = document.getElementById('default-prompt');
  if (dpEl) dpEl.value = p.defaultPrompt ?? '';
  const dsEl = document.getElementById('default-seed');
  if (dsEl) dsEl.value = String(p.defaultSeed ?? -1);
  // Reset flag after Shoelace finishes processing any queued microtasks
  setTimeout(() => { _applyingProject = false; }, 100);
  updateSegDurationHint(p);
  renderAssetList();
  timelineSetProject(p);
  updateGenerateButton();
  if (p.sourceClips.length > 0) {
    playerBuildPlaylist(p.segments, p.id, p.sourceClips);
    document.getElementById('btn-compare').disabled = false;
  }
  updateExportButton();
}

function updateSegDurationHint(p) {
  const hint = document.getElementById('seg-duration-hint');
  if (!hint) return;
  const genFps  = p?.genFps  ?? 8;
  const genFrms = p?.genFramesPerSegment ?? 81;
  const sec     = (genFrms / genFps).toFixed(1);
  hint.textContent = `${genFrms} frames ÷ ${genFps}fps = ~${sec}s per segment`;
}

// ── Header project name ────────────────────────────────────────
const nameInput = document.getElementById('header-project-name');

function setHeaderName(val) {
  nameInput.value = val;
  nameInput.style.width = Math.max(4, val.length) + 'ch';
}

nameInput.addEventListener('input', () => {
  nameInput.style.width = Math.max(4, nameInput.value.length) + 'ch';
});

nameInput.addEventListener('blur', async () => {
  const name = nameInput.value.trim() || 'untitled';
  setHeaderName(name);
  if (!state.project) return;
  state.project.name = name;
  document.getElementById('project-name').value = name;
  await fetch(`/api/project/${state.project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
});

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
  if (e.key === 'Escape') { nameInput.value = state.project?.name || 'untitled'; nameInput.blur(); }
});

// Prevent the switcher from opening when clicking directly into the text field
nameInput.addEventListener('click', e => e.stopPropagation());

// ── Project switcher ───────────────────────────────────────────
const switcher    = document.getElementById('project-switcher');
const btnSwitch   = document.getElementById('btn-project-switch');
const projectGrid = document.getElementById('project-grid');

btnSwitch.addEventListener('click', async e => {
  e.stopPropagation();
  if (!switcher.hidden) { closeSwitcher(); return; }
  await renderProjectGrid();
  switcher.hidden = false;
});

function closeSwitcher() { switcher.hidden = true; }

document.addEventListener('click', e => {
  if (!switcher.hidden && !switcher.contains(e.target) && e.target !== btnSwitch) closeSwitcher();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSwitcher();
});

// Prevent clicks inside the panel from bubbling to the document close handler
switcher.addEventListener('click', e => e.stopPropagation());

async function renderProjectGrid() {
  projectGrid.innerHTML = '<div class="project-grid-empty">Loading…</div>';
  let projects;
  try {
    const res = await fetch('/api/projects');
    ({ projects } = await res.json());
  } catch (err) {
    projectGrid.innerHTML = `<div class="project-grid-empty">Error loading projects</div>`;
    console.error('renderProjectGrid error:', err);
    return;
  }

  projectGrid.innerHTML = '';

  if (!projects.length) {
    projectGrid.innerHTML = '<div class="project-grid-empty">No projects yet</div>';
    return;
  }

  projects.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  projects.forEach(p => {
    const card = document.createElement('div');
    const isActive = p.id === state.project?.id;
    card.className = `project-card${isActive ? ' active' : ''}`;
    card.dataset.id = p.id;

    const meta = [
      p.clipCount    ? `${p.clipCount} clip${p.clipCount !== 1 ? 's' : ''}` : null,
      p.segmentCount ? `${p.segmentCount} seg${p.segmentCount !== 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ') || 'empty';

    card.innerHTML = `
      <div class="project-card-name">${escHtml(p.name || 'untitled')}</div>
      <div class="project-card-meta">${meta}</div>
      <button class="project-card-delete" title="Delete project" data-id="${p.id}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
      </button>
    `;

    card.addEventListener('click', e => {
      if (e.target.closest('.project-card-delete')) return;
      if (isActive) { closeSwitcher(); return; }
      localStorage.setItem('motionStudioProjectId', p.id);
      location.href = `/projects/${p.id}`;
    });

    card.querySelector('.project-card-delete').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name || 'untitled'}"? This cannot be undone.`)) return;
      await fetch(`/api/project/${p.id}`, { method: 'DELETE' });
      if (p.id === state.project?.id) {
        localStorage.removeItem('motionStudioProjectId');
        location.href = '/';
      } else {
        card.remove();
        if (!projectGrid.querySelector('.project-card'))
          projectGrid.innerHTML = '<div class="project-grid-empty">No projects yet</div>';
      }
    });

    projectGrid.appendChild(card);
  });
}

// New project from switcher
document.getElementById('btn-new-project').addEventListener('click', async e => {
  e.stopPropagation();
  const res = await fetch('/api/project', { method: 'POST' });
  const p   = await res.json();
  localStorage.setItem('motionStudioProjectId', p.id);
  location.href = `/projects/${p.id}`;
});

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Asset list ─────────────────────────────────────────────────
function renderAssetList() {
  const p = state.project;
  if (!p) return;
  const clips    = new Set(p.sourceClips.map(c => c.filename));
  const uploads  = document.getElementById('uploads-list');
  uploads.innerHTML = '';
  if (!p.assets.length) {
    uploads.innerHTML = '<div class="empty-assets">No uploads yet</div>';
  } else {
    p.assets.filter(a =>  clips.has(a)).forEach(n => uploads.appendChild(makeAssetItem('video', n)));
    p.assets.filter(a => !clips.has(a)).forEach(n => uploads.appendChild(makeAssetItem('image', n)));
  }
  const genList = document.getElementById('generated-list');
  const assets  = p.generatedAssets ?? [];
  if (!assets.length) {
    genList.innerHTML = '<div class="empty-assets">No generated assets</div>';
  } else {
    genList.innerHTML = '';
    // Sort by segmentIndex then version
    const sorted = [...assets].sort((a, b) =>
      a.segmentIndex !== b.segmentIndex ? a.segmentIndex - b.segmentIndex : a.version - b.version
    );
    sorted.forEach(asset => {
      const seg   = p.segments.find(s => s.id === asset.segId);
      const segNum = (asset.segmentIndex ?? 0) + 1;
      const label  = asset.version === 0 ? `Seg ${segNum}` : `Seg ${segNum}.${asset.version}`;
      const isActive = seg?.generatedVideo === asset.filename;
      genList.appendChild(makeGenAssetItem(asset, label, isActive, p.id));
    });
  }
}

let _assetViewMode = 'list'; // 'list' | 'grid'

document.getElementById('btn-view-list').addEventListener('click', () => setAssetView('list'));
document.getElementById('btn-view-grid').addEventListener('click', () => setAssetView('grid'));

function setAssetView(mode) {
  _assetViewMode = mode;
  document.getElementById('btn-view-list').classList.toggle('active', mode === 'list');
  document.getElementById('btn-view-grid').classList.toggle('active', mode === 'grid');
  const list = document.getElementById('uploads-list');
  list.classList.toggle('grid-view', mode === 'grid');
  // Rebuild so thumbs show/hide properly
  renderAssetList();
}

function makeAssetItem(type, name) {
  const el = document.createElement('div');
  el.className = 'asset-item';
  el.draggable = true;
  el.dataset.filename = name;
  el.dataset.assetType = type;

  const isImage = type === 'image';
  const projectId = state.project?.id;
  const thumbSrc  = isImage && projectId
    ? `/media/${projectId}/uploads/${encodeURIComponent(name)}`
    : null;

  if (_assetViewMode === 'grid' && isImage && thumbSrc) {
    el.innerHTML = `<img class="asset-thumb" src="${escHtml(thumbSrc)}" alt="${escHtml(name)}" loading="lazy"><span class="asset-name" title="${escHtml(name)}">${escHtml(name)}</span>`;
  } else {
    el.innerHTML = `<span class="asset-type-icon">${type === 'video' ? '🎥' : '🖼'}</span><span class="asset-name" title="${escHtml(name)}">${escHtml(name)}</span>`;
  }

  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', name);
    if (isImage) {
      e.dataTransfer.setData('application/x-ms-asset-image', name);
    } else {
      // Include the clip ID so the timeline can dispatch clip:appendsegments
      const clip = state.project?.sourceClips.find(c => c.filename === name);
      if (clip) e.dataTransfer.setData('application/x-ms-asset-video', clip.id);
    }
    e.dataTransfer.effectAllowed = 'copy';
  });

  if (isImage) {
    el.addEventListener('click', () => showAssetInPanel(name, thumbSrc, el));
  }

  return el;
}

function makeGenAssetItem(asset, label, isActive, projectId) {
  const el = document.createElement('div');
  el.className = 'asset-item gen-asset-item' + (isActive ? ' gen-asset-active' : '');
  el.dataset.assetId = asset.id;

  const src = `/media/${projectId}/generated/${encodeURIComponent(asset.filename)}`;
  el.innerHTML = `
    <span class="asset-type-icon">🎬</span>
    <span class="asset-name gen-asset-label">${escHtml(label)}</span>
    ${isActive ? '<span class="gen-asset-badge">active</span>' : ''}
    <span class="gen-asset-actions">
      ${!isActive ? `<button class="gen-asset-use" data-asset-id="${asset.id}" title="Set as active">Use</button>` : ''}
      <button class="gen-asset-del" data-asset-id="${asset.id}" title="Delete">✕</button>
    </span>
  `;

  // Click label/icon → open video in new tab
  el.querySelector('.gen-asset-label').addEventListener('click', () => window.open(src, '_blank'));
  el.querySelector('.asset-type-icon').addEventListener('click', () => window.open(src, '_blank'));

  // Use button → assign as active
  const useBtn = el.querySelector('.gen-asset-use');
  if (useBtn) {
    useBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const p = state.project;
      if (!p) return;
      const seg = p.segments.find(s => s.id === asset.segId);
      if (!seg) return;
      await fetch(`/api/project/${p.id}/segments/${seg.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generatedVideo: asset.filename }),
      });
      seg.generatedVideo = asset.filename;
      state.project = p;
      renderAssetList();
      playerBuildPlaylist(p.segments, p.id, p.sourceClips);
      timelineSetProject(p);
    });
  }

  // Delete button → remove file + asset
  el.querySelector('.gen-asset-del').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    const p = state.project;
    if (!p) return;
    const res  = await fetch(`/api/project/${p.id}/generatedAssets/${asset.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Delete failed'); return; }
    state.project = data.project;
    renderAssetList();
    playerBuildPlaylist(data.project.segments, data.project.id, data.project.sourceClips);
    timelineSetProject(data.project);
  });

  return el;
}

function showAssetInPanel(name, src, itemEl) {
  // Deselect all
  document.querySelectorAll('.asset-item.active').forEach(e => e.classList.remove('active'));
  itemEl?.classList.add('active');

  _clearElapsedTimer();
  // Hide all other panels, show asset props
  document.getElementById('job-props').hidden           = true;
  document.getElementById('frame-props-empty').hidden   = true;
  document.getElementById('frame-props-content').hidden = true;
  document.getElementById('asset-props').hidden         = false;
  document.getElementById('right-panel-title').textContent = name;

  const img = document.getElementById('asset-props-img');
  img.src = src;
  img.onload = () => {
    document.getElementById('asset-props-details').innerHTML = `
      <div class="asset-props-row"><span>Dimensions</span><span>${img.naturalWidth} × ${img.naturalHeight}</span></div>
      <div class="asset-props-row"><span>Filename</span><span>${escHtml(name)}</span></div>
    `;
  };
}

// ── Upload ─────────────────────────────────────────────────────
const importZone = document.getElementById('import-zone');
const fileInput  = document.getElementById('file-input');
const btnImport  = document.getElementById('btn-import');

importZone.addEventListener('click', e => { if (e.target !== btnImport) fileInput.click(); });
btnImport.addEventListener('click',  e => { e.stopPropagation(); fileInput.click(); });

importZone.addEventListener('dragover',  e => { e.preventDefault(); importZone.classList.add('drag-over'); });
importZone.addEventListener('dragleave', e => { if (!importZone.contains(e.relatedTarget)) importZone.classList.remove('drag-over'); });
importZone.addEventListener('drop',      e => { e.preventDefault(); importZone.classList.remove('drag-over'); uploadFiles([...e.dataTransfer.files]); });
fileInput.addEventListener('change',     () => { uploadFiles([...fileInput.files]); fileInput.value = ''; });

async function uploadFiles(files) {
  if (!state.project || !files.length) return;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    try {
      const res  = await fetch(`/api/project/${state.project.id}/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.project = data.project;
      applyProject();
    } catch (e) { console.error('Upload failed:', e); }
  }
}

// ── Generate button ────────────────────────────────────────────
function updateGenerateButton() {
  const p   = state.project;
  const btn = document.getElementById('btn-generate');
  const n   = p?.segments.filter(s => s.selected).length ?? 0;
  btn.textContent = `Generate ${n} →`;
  btn.disabled    = n === 0;
}

document.getElementById('btn-generate').addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  const n = p.segments.filter(s => s.selected).length;
  if (n === 0) return;

  // Pre-fill modal from current project state
  document.getElementById('gen-modal-name').value   = p.name || 'untitled';
  document.getElementById('gen-modal-mode').value   = p.mode || 'subject-replacement';
  document.getElementById('gen-modal-prompt').value = p.defaultPrompt || '';
  document.getElementById('gen-modal-count').textContent = n;
  document.getElementById('generate-modal').hidden  = false;
  document.getElementById('gen-modal-prompt').focus();
});

document.getElementById('btn-gen-modal-cancel').addEventListener('click', () => {
  document.getElementById('generate-modal').hidden = true;
});

document.getElementById('generate-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('generate-modal'))
    document.getElementById('generate-modal').hidden = true;
});

document.getElementById('btn-gen-modal-confirm').addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const clip = p.sourceClips[0];
  if (!clip) return;

  const name   = document.getElementById('gen-modal-name').value.trim() || 'untitled';
  const mode   = document.getElementById('gen-modal-mode').value;
  const prompt = document.getElementById('gen-modal-prompt').value.trim();

  document.getElementById('generate-modal').hidden = true;

  // Save project name/mode if changed
  const updates = {};
  if (name !== (p.name || 'untitled'))            updates.name = name;
  if (mode !== (p.mode || 'subject-replacement')) updates.mode = mode;
  if (Object.keys(updates).length > 0) {
    const pr = await fetch(`/api/project/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (pr.ok) { const { project } = await pr.json(); state.project = project; applyProject(); }
  }

  // Switch to logs panel
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-panel="logs"]').classList.add('active');
  document.querySelectorAll('.panel-content').forEach(c => c.classList.remove('active'));
  document.getElementById('panel-logs').classList.add('active');

  try {
    const res = await fetch(`/api/project/${p.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clipId: clip.id,
        prompt: prompt || undefined,
        segIds: p.segments.filter(s => s.selected).map(s => s.id),
      }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to queue generation'); return; }
    [...data.jobs].reverse().forEach(watchJob);
  } catch (e) {
    console.error('Generate error:', e);
  }
});

// ── Job log panel ──────────────────────────────────────────────
const _jobs = new Map(); // jobId → job object
let _sortAsc = localStorage.getItem('logsSortAsc') !== 'false';

// Estimated generation time: ~10 min per 81 frames, linear scale
const _SECS_PER_FRAME = 600 / 81;

function _estimatePct(job) {
  if (!job.startedAt) return '~0%';
  const elapsed    = (Date.now() - new Date(job.startedAt)) / 1000;
  const frameCount = job.params?.frameCount ?? 81;
  const estimated  = frameCount * _SECS_PER_FRAME;
  return `~${Math.min(99, Math.round((elapsed / estimated) * 100))}%`;
}

// Tick all visible running-job percentage displays every second
setInterval(() => {
  document.querySelectorAll('.job-card[data-status="running"] .job-pct').forEach(el => {
    const startedAt  = el.dataset.startedAt;
    const frameCount = parseInt(el.dataset.frameCount, 10) || 81;
    if (!startedAt) return;
    const elapsed   = (Date.now() - new Date(startedAt)) / 1000;
    const estimated = frameCount * _SECS_PER_FRAME;
    el.textContent  = `~${Math.min(99, Math.round((elapsed / estimated) * 100))}%`;
  });
}, 1000);

function sortJobList() {
  const list = document.getElementById('jobs-list');
  if (!list) return;
  const cards = [...list.querySelectorAll('.job-card')];
  cards.sort((a, b) => {
    const ja = _jobs.get(a.dataset.jobId);
    const jb = _jobs.get(b.dataset.jobId);
    const ta = new Date(ja?.queuedAt || ja?.createdAt || 0).getTime();
    const tb = new Date(jb?.queuedAt || jb?.createdAt || 0).getTime();
    if (ta !== tb) return _sortAsc ? ta - tb : tb - ta;
    const sa = ja?.params?.segmentIndex ?? 0;
    const sb = jb?.params?.segmentIndex ?? 0;
    return _sortAsc ? sa - sb : sb - sa;
  });
  cards.forEach(c => list.appendChild(c));
}

document.getElementById('btn-sort-logs')?.addEventListener('click', () => {
  _sortAsc = !_sortAsc;
  localStorage.setItem('logsSortAsc', _sortAsc);
  const btn = document.getElementById('btn-sort-logs');
  btn.classList.toggle('asc', _sortAsc);
  btn.title = _sortAsc ? 'Sort: newest first' : 'Sort: oldest first';
  sortJobList();
});

document.getElementById('btn-refresh-logs')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) return;
    const { jobs } = await res.json();
    jobs.forEach(job => watchJob(job));
  } catch { /* ignore */ }
});

// One-time tab wiring for job detail panel
document.getElementById('job-media-tabs')?.addEventListener('click', e => {
  const btn = e.target.closest('.media-tab');
  if (!btn) return;
  document.querySelectorAll('#job-media-tabs .media-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tab = btn.dataset.tab;
  document.getElementById('job-media-ref').hidden = tab !== 'ref';
  document.getElementById('job-media-gen').hidden = tab !== 'gen';
});

function ensureLogsContainer() {
  const panel = document.getElementById('panel-logs');
  let list = panel.querySelector('#jobs-list');
  if (!list) {
    panel.querySelector('.logs-empty')?.remove();
    list = document.createElement('div');
    list.id = 'jobs-list';
    list.className = 'jobs-list';
    panel.appendChild(list);
  }
  return list;
}

function renderJob(job) {
  _jobs.set(job.id, job);
  const list  = ensureLogsContainer();
  const isNew = !list.querySelector(`[data-job-id="${job.id}"]`);
  let card = list.querySelector(`[data-job-id="${job.id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'job-card';
    card.dataset.jobId = job.id;
    list.appendChild(card);
    card.addEventListener('click', () => showJobInPanel(job.id));
  }

  const isQwen   = job.params?.jobType === 'qwen-edit';
  const jobLabel = isQwen
    ? `Frame ${job.params?.frameIndex ?? '?'}${job.params?.nsfw ? ' (NSFW)' : ''}`
    : `Seg ${(job.params?.segmentIndex ?? 0) + 1}`;
  const status   = job.status;
  const projName = job.params?.projectName ? escHtml(job.params.projectName) : '';
  const isRunning = status === 'running';

  card.dataset.status = status;

  const errLine  = job.error ? `<div class="job-error">${escHtml(job.error)}</div>` : '';
  const retryBtn = status === 'failed'
    ? `<button class="job-retry-btn" data-job-id="${job.id}">↺ Retry</button>`
    : '';

  const label = projName ? `${projName}  ${jobLabel}` : jobLabel;
  const right = isRunning
    ? `<span class="job-pct" data-started-at="${job.startedAt ?? ''}" data-frame-count="${job.params?.frameCount ?? 81}">${_estimatePct(job)}</span>`
    : `<span class="job-badge job-badge-${status}">${status}</span>`;

  card.innerHTML = `
    <div class="job-row">
      <span class="job-label">${label}</span>
      ${right}
    </div>
    ${errLine}${retryBtn}
  `;

  // Pulse dot on logs icon when any job is active
  const anyActive = [..._jobs.values()].some(j => ['pending','waiting','running'].includes(j.status));
  const pulse = document.getElementById('logs-pulse');
  if (pulse) pulse.hidden = !anyActive;

  if (isNew) sortJobList();
  timelineSetJobs([..._jobs.values()]);
}

// Single global SSE — replaces per-job EventSource streams
let _globalStream = null;
function ensureGlobalStream() {
  if (_globalStream && _globalStream.readyState !== EventSource.CLOSED) return;
  _globalStream = new EventSource('/api/jobs/stream');
  _globalStream.onmessage = e => {
    const updated = JSON.parse(e.data);
    _jobs.set(updated.id, { ...(_jobs.get(updated.id) ?? {}), ...updated });
    renderJob(updated);
    if (updated.status === 'done') onJobDone(updated);
  };
}

function watchJob(job) {
  _jobs.set(job.id, job);
  renderJob(job);
  if (job.status === 'done') { onJobDone(job); return; }
  if (['failed', 'cancelled'].includes(job.status)) return;
  ensureGlobalStream();
}

// Delegated retry handler on logs panel
document.getElementById('panel-logs').addEventListener('click', async e => {
  const retryEl = e.target.closest('.job-retry-btn');
  if (!retryEl) return;
  const jobId = retryEl.dataset.jobId;
  const job = _jobs.get(jobId);
  if (!job) return;
  const p = state.project;
  if (!p) return;
  const segId = job.params?.segId;
  const clipId = job.params?.clipId;
  if (!segId || !clipId) return;
  const res = await fetch(`/api/project/${p.id}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clipId, segIds: [segId] }),
  });
  if (!res.ok) return;
  const data = await res.json();
  data.jobs.forEach(watchJob);
});

// Delegated cancel handler on right panel job details
document.getElementById('job-props').addEventListener('click', async e => {
  const cancelEl = e.target.closest('.job-cancel-btn');
  if (cancelEl) {
    const jobId = cancelEl.dataset.jobId;
    const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    if (res.ok) {
      const { job } = await res.json();
      renderJob(job);
      showJobInPanel(jobId);
    }
    return;
  }

  const retryEl = e.target.closest('.job-retry-btn');
  if (retryEl) {
    const jobId = retryEl.dataset.jobId;
    retryEl.disabled = true;
    retryEl.textContent = 'Retrying…';
    const res = await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
    if (res.ok) {
      const { job: newJob } = await res.json();
      watchJob(newJob);
      // Refresh old job card too
      const oldJob = _jobs.get(jobId);
      if (oldJob) renderJob({ ...oldJob, status: 'cancelled' });
    } else {
      retryEl.disabled = false;
      retryEl.textContent = '↺ Retry Job';
      alert('Retry failed');
    }
  }
});

async function onJobDone(job) {
  const segId     = job.params?.segId;
  const output    = job.result?.outputPath;
  const projectId = job.params?.projectId;
  if (!segId || !output || !projectId) return;

  const filename = output.split('/').pop();
  const p = state.project;
  if (!p || p.id !== projectId) return;

  const res = await fetch(`/api/project/${p.id}/segments/${segId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generatedVideo: filename }),
  });
  if (!res.ok) return;
  const { project } = await res.json();

  // syncJobToProject runs server-side concurrently, so generatedAssets may not be in the
  // PATCH response yet — add the entry locally if it's missing
  if (!project.generatedAssets) project.generatedAssets = [];
  const alreadyTracked = project.generatedAssets.some(a => a.filename === filename);
  if (!alreadyTracked) {
    const seg      = project.segments.find(s => s.id === segId);
    const segIdx   = project.segments.indexOf(seg);
    const existing = project.generatedAssets.filter(a => a.segId === segId);
    project.generatedAssets.push({
      id:           `ga-local-${Date.now()}`,
      filename,
      segId,
      segmentIndex: segIdx,
      version:      existing.length,
      createdAt:    new Date().toISOString(),
    });
  }

  state.project = project;
  timelineSetProject(project);
  renderAssetList();
  if (p.sourceClips.length > 0) playerBuildPlaylist(project.segments, project.id, project.sourceClips);
  updateExportButton();
}

// ── Job detail in right panel ──────────────────────────────────
let _elapsedTimer = null;

function _fmtElapsed(startedAt, endAt) {
  if (!startedAt) return '—';
  const sec = Math.round((new Date(endAt ?? Date.now()) - new Date(startedAt)) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function _clearElapsedTimer() {
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
}

function showJobInPanel(jobId) {
  _clearElapsedTimer();

  const job = _jobs.get(jobId);
  if (!job) return;

  document.querySelectorAll('.job-card').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-job-id="${jobId}"]`)?.classList.add('active');

  document.getElementById('asset-props').hidden          = true;
  document.getElementById('frame-props-empty').hidden    = true;
  document.getElementById('frame-props-content').hidden  = true;
  document.getElementById('job-props').hidden            = false;

  const isQwen = job.params?.jobType === 'qwen-edit';
  const seg    = (job.params?.segmentIndex ?? 0) + 1;
  const label  = isQwen
    ? `Frame ${job.params?.frameIndex ?? '?'}${job.params?.nsfw ? ' (NSFW)' : ''} — ${job.status}`
    : `Segment ${seg} — ${job.status}`;
  document.getElementById('right-panel-title').textContent = label;

  const pid = job.params?.projectId ?? state.project?.id;
  const ref = job.params?.referenceImageFilename;
  const img = document.getElementById('job-props-ref-img');
  img.src    = ref && pid ? `/media/${pid}/uploads/${encodeURIComponent(ref)}` : '';
  img.hidden = !ref;

  // Show prompt below image for Qwen jobs
  const promptEl = document.getElementById('job-props-prompt');
  if (promptEl) {
    const prompt = job.params?.prompt?.trim();
    if (isQwen && prompt) {
      promptEl.textContent = prompt;
      promptEl.hidden = false;
    } else {
      promptEl.hidden = true;
    }
  }

  // Reset to ref tab on each open
  document.querySelectorAll('#job-media-tabs .media-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'ref'));
  document.getElementById('job-media-ref').hidden = false;
  document.getElementById('job-media-gen').hidden = true;

  // Gen video / image tab content
  const outputFile = job.result?.outputPath?.split('/').pop();
  const genContent = document.getElementById('job-props-gen-content');
  if (genContent) {
    if (job.status === 'done' && outputFile && pid) {
      if (isQwen) {
        genContent.innerHTML = `
          <div class="asset-props-img-wrap">
            <img src="/media/${pid}/uploads/${encodeURIComponent(outputFile)}" alt="Qwen output" style="width:100%;border-radius:6px;display:block">
          </div>
          ${job.params?.prompt ? `<div class="job-props-prompt">${escHtml(job.params.prompt)}</div>` : ''}
        `;
      } else {
        genContent.innerHTML = `<video src="/media/${pid}/generated/${encodeURIComponent(outputFile)}" controls playsinline style="width:100%;border-radius:6px;display:block"></video>`;
      }
    } else if (job.status === 'running') {
      genContent.innerHTML = `<div class="gen-status-pulse">Generating…</div>`;
    } else if (job.status === 'waiting') {
      genContent.innerHTML = `<div class="gen-status-idle">Waiting — ComfyUI busy</div>`;
    } else if (job.status === 'pending') {
      genContent.innerHTML = `<div class="gen-status-idle">Pending</div>`;
    } else {
      genContent.innerHTML = `<div class="gen-status-idle">—</div>`;
    }
  }

  const queued    = (job.queuedAt || job.createdAt) ? new Date(job.queuedAt || job.createdAt).toLocaleTimeString() : '—';
  const started   = job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—';
  const isLive    = job.status === 'running' && job.startedAt && !job.completedAt;
  const elapsed   = _fmtElapsed(job.startedAt, job.completedAt);

  const outputLink = outputFile && pid
    ? `<a href="/media/${pid}/generated/${encodeURIComponent(outputFile)}" target="_blank" class="job-result-link">▶ View output</a>`
    : null;

  const canCancel = ['pending','waiting','running'].includes(job.status);

  const sharedRows = `
    <div class="asset-props-row"><span>Status</span><span class="job-badge job-badge-${job.status}">${job.status}</span></div>
    <div class="asset-props-row"><span>Project</span><span>${escHtml(job.params?.projectName ?? '—')}</span></div>
  `;
  const tailRows = `
    <div class="asset-props-row"><span>Queued</span><span>${queued}</span></div>
    <div class="asset-props-row"><span>Started</span><span>${started}</span></div>
    <div class="asset-props-row"><span>Elapsed</span><span id="job-elapsed">${elapsed}</span></div>
    ${job.error ? `<div class="asset-props-row" style="color:#b91c1c"><span>Error</span><span style="word-break:break-word">${escHtml(job.error)}</span></div>` : ''}
    ${outputLink ? `<div class="asset-props-row">${outputLink}</div>` : ''}
    ${canCancel ? `<div class="job-cancel-row"><button class="job-cancel-btn" data-job-id="${job.id}">✕ Cancel Job</button></div>` : ''}
    ${(canCancel || job.status === 'failed') ? `<div class="job-cancel-row"><button class="job-retry-btn" data-job-id="${job.id}">↺ Retry Job</button></div>` : ''}
  `;

  let specificRows;
  if (isQwen) {
    const prompt = job.params?.prompt?.trim();
    specificRows = `
      <div class="asset-props-row"><span>Type</span><span>Qwen Edit${job.params?.nsfw ? ' (NSFW)' : ' (Safe)'}</span></div>
      <div class="asset-props-row"><span>Frame #</span><span>${job.params?.frameIndex ?? '—'}</span></div>
      ${prompt ? `<div class="asset-props-row asset-props-row--prompt"><span>Prompt</span><span>${escHtml(prompt)}</span></div>` : ''}
    `;
  } else {
    const durSec = job.params ? (job.params.frameCount / job.params.genFps).toFixed(1) : '—';
    specificRows = `
      <div class="asset-props-row"><span>Segment #</span><span>${seg}</span></div>
      <div class="asset-props-row"><span>Frames</span><span>${job.params?.frameCount ?? '—'}</span></div>
      <div class="asset-props-row"><span>Gen FPS</span><span>${job.params?.genFps ?? '—'}</span></div>
      <div class="asset-props-row"><span>Duration</span><span>${durSec}s</span></div>
      <div class="asset-props-row"><span>Start frame</span><span>${job.params?.startFrame ?? 0}</span></div>
      <div class="asset-props-row"><span>Seed</span><span>${job.params?.seed ?? '—'}</span></div>
    `;
  }

  document.getElementById('job-props-details').innerHTML = sharedRows + specificRows + tailRows;

  if (isLive) {
    _elapsedTimer = setInterval(() => {
      const el = document.getElementById('job-elapsed');
      if (!el) { _clearElapsedTimer(); return; }
      const current = _jobs.get(jobId);
      if (!current || current.status !== 'running') { _clearElapsedTimer(); return; }
      el.textContent = _fmtElapsed(current.startedAt, null);
    }, 1000);
  }
}

// ── Frame select → right panel ─────────────────────────────────
let _selectedSegIdForFrame = null;

document.addEventListener('frame:select', async e => {
  const { clipId, frameIndex } = e.detail;
  state.selectedFrame = { clipId, frameIndex };

  document.querySelectorAll('.asset-item.active').forEach(el => el.classList.remove('active'));
  document.getElementById('job-props').hidden           = true;
  document.getElementById('asset-props').hidden         = true;
  document.getElementById('right-panel-title').textContent = 'Frame Properties';
  document.getElementById('frame-props-empty').hidden   = true;
  document.getElementById('frame-props-content').hidden = false;

  const p    = state.project;
  const clip = p?.sourceClips.find(c => c.id === clipId);
  if (!clip) return;

  // Populate per-segment prompt
  const seg = p?.segments.find(s =>
    s.sourceClipId === clipId &&
    frameIndex >= s.startFrame &&
    frameIndex < s.startFrame + s.frameCount
  );
  _selectedSegIdForFrame = seg?.id ?? null;
  const framePromptEl = document.getElementById('frame-prompt');
  if (framePromptEl) framePromptEl.value = seg?.prompt ?? '';

  const thumb = document.getElementById('frame-thumb');
  thumb.src = '';
  try {
    const res = await fetch(`/api/project/${p.id}/thumbnails?clipId=${clipId}&start=${frameIndex}&end=${frameIndex}`);
    const { frames } = await res.json();
    if (frames.length) thumb.src = frames[0].url;
  } catch { /* leave blank */ }

  playerSeek(frameIndex / clip.fps);
});

// Save per-segment prompt on blur
document.getElementById('frame-prompt')?.addEventListener('blur', async e => {
  const p = state.project;
  if (!p || !_selectedSegIdForFrame) return;
  const value = e.target.value?.trim() || null;
  await fetch(`/api/project/${p.id}/segments/${_selectedSegIdForFrame}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: value }),
  });
  // Update local state
  const seg = p.segments.find(s => s.id === _selectedSegIdForFrame);
  if (seg) seg.prompt = value;
});

// ── Panel switching ────────────────────────────────────────────
document.querySelectorAll('.rail-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${btn.dataset.panel}`)?.classList.add('active');
  });
});

// ── Settings sync ──────────────────────────────────────────────
document.getElementById('project-name')?.addEventListener('input', e => {
  if (!_applyingProject) setHeaderName(e.target.value || 'untitled');
});

document.getElementById('gen-fps')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  const newVal = Number(e.target.value);
  if (newVal === (p.genFps ?? 24)) return;
  const res = await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ genFps: newVal }),
  });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  updateSegDurationHint(project);
  timelineSetProject(project);
  updateGenerateButton();
});

document.getElementById('gen-frames-per-segment')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  const newVal = Number(e.target.value);
  if (newVal === (p.genFramesPerSegment ?? 81)) return;
  const res = await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ genFramesPerSegment: newVal }),
  });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  updateSegDurationHint(project);
  timelineSetProject(project);
  updateGenerateButton();
});

document.getElementById('project-name')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const name = e.target.value?.trim() || 'untitled';
  setHeaderName(name);
  const p = state.project;
  if (!p) return;
  p.name = name;
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
});

document.getElementById('aspect-ratio')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aspectRatio: e.target.value }),
  });
});

document.getElementById('gen-mode')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: e.target.value }),
  });
});

let _defaultPromptDebounce = null;
document.getElementById('default-prompt')?.addEventListener('input', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  clearTimeout(_defaultPromptDebounce);
  _defaultPromptDebounce = setTimeout(async () => {
    await fetch(`/api/project/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPrompt: e.target.value }),
    });
  }, 300);
});

document.getElementById('default-seed')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultSeed: Number(e.target.value) }),
  });
});

// ── Segment delete ─────────────────────────────────────────────
async function deleteSegment(segId) {
  const p = state.project;
  if (!p || !segId) return;
  const res = await fetch(`/api/project/${p.id}/segments/${segId}`, { method: 'DELETE' });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  timelineClearSelection();
  applyProject();
}

document.addEventListener('segment:delete', e => deleteSegment(e.detail.segId));

async function setSegmentRef(segId, filename) {
  const p = state.project;
  if (!p) return;
  const res = await fetch(`/api/project/${p.id}/segments/${segId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenceImage: filename }),
  });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  timelineSetProject(project);
}

document.addEventListener('segment:setref', e => setSegmentRef(e.detail.segId, e.detail.filename));

document.addEventListener('segment:toggleselect', async e => {
  const p = state.project;
  if (!p) return;
  const seg = p.segments.find(s => s.id === e.detail.segId);
  if (!seg) return;
  seg.selected = !seg.selected;
  timelineSetProject(p);
  updateGenerateButton();
  await fetch(`/api/project/${p.id}/segments/${seg.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected: seg.selected }),
  });
});

document.addEventListener('segment:togglegen', e => {
  const { segId } = e.detail;
  if (window._hiddenGenSegIds.has(segId)) {
    window._hiddenGenSegIds.delete(segId);
  } else {
    window._hiddenGenSegIds.add(segId);
  }
  playerToggleGenSeg(segId);
  const p = state.project;
  if (p?.sourceClips.length > 0) playerBuildPlaylist(p.segments, p.id, p.sourceClips);
  timelineRedraw();
});

document.addEventListener('clip:appendsegments', async e => {
  const { clipId } = e.detail;
  const p = state.project;
  if (!p) return;
  const res = await fetch(`/api/project/${p.id}/clips/${clipId}/segments`, { method: 'POST' });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  timelineSetProject(project);
  playerBuildPlaylist(project.segments, project.id, project.sourceClips);
  updateGenerateButton();
});

let _selectedSegId = null;
document.addEventListener('segment:select', e => { _selectedSegId = e.detail.segId; });
document.getElementById('ctx-delete-seg').addEventListener('click', () => {
  if (_selectedSegId) deleteSegment(_selectedSegId);
});

document.getElementById('ctx-duplicate-seg')?.addEventListener('click', async () => {
  if (!_selectedSegId) return;
  const p = state.project;
  if (!p) return;
  const res = await fetch(`/api/project/${p.id}/segments/${_selectedSegId}/duplicate`, { method: 'POST' });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  timelineSetProject(project);
  updateGenerateButton();
});

// ── Support image drop zone ────────────────────────────────────
let _supportImageFilename = null;
const supportZone = document.getElementById('support-drop-zone');
supportZone?.addEventListener('dragover',  e => { e.preventDefault(); supportZone.classList.add('drag-over'); });
supportZone?.addEventListener('dragleave', e => { if (!supportZone.contains(e.relatedTarget)) supportZone.classList.remove('drag-over'); });
supportZone?.addEventListener('drop', e => {
  e.preventDefault();
  supportZone.classList.remove('drag-over');
  const filename = e.dataTransfer.getData('application/x-ms-asset-image') || e.dataTransfer.getData('text/plain');
  if (filename) {
    _supportImageFilename = filename;
    const span = supportZone.querySelector('span');
    if (span) span.textContent = filename;
    supportZone.title = filename;
  }
});

// ── Apply with Qwen ────────────────────────────────────────────
document.getElementById('btn-apply-qwen')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p || !state.selectedFrame) return;
  const { clipId, frameIndex } = state.selectedFrame;
  const prompt = document.getElementById('frame-prompt')?.value?.trim() || '';
  const nsfw   = document.getElementById('chk-qwen-nsfw')?.checked ?? false;
  const btn    = document.getElementById('btn-apply-qwen');

  btn.disabled = true;
  btn.textContent = 'Queued…';
  try {
    const res = await fetch(`/api/project/${p.id}/frame-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId, frameIndex, prompt, supportImage: _supportImageFilename, nsfw }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Qwen edit failed'); btn.disabled = false; btn.textContent = 'Apply with Qwen →'; return; }

    const jobId = data.jobId;
    btn.textContent = 'Running Qwen…';

    // Add pulsing placeholder in Uploads panel
    const uploadsList = document.getElementById('uploads-list');
    const placeholder = document.createElement('div');
    placeholder.className = 'asset-item qwen-placeholder';
    placeholder.dataset.qwenJob = jobId;
    placeholder.innerHTML = '<span>Generating in Qwen…</span>';
    if (uploadsList) uploadsList.prepend(placeholder);

    // Watch via global SSE for this job
    const es = new EventSource('/api/jobs/stream');
    es.onmessage = async e => {
      const updated = JSON.parse(e.data);
      if (updated.id !== jobId) return;
      if (updated.status === 'done') {
        es.close();
        btn.disabled = false;
        btn.textContent = 'Apply with Qwen →';
        // Remove placeholder and refresh asset list
        document.querySelector(`[data-qwen-job="${jobId}"]`)?.remove();
        // Reload project to pick up new asset + frameEdits
        const proj = await fetch(`/api/project/${p.id}`).then(r => r.json());
        state.project = proj;
        renderAssetList();
        // Update frame thumbnail
        const filename = updated.result?.outputPath?.split('/').pop();
        const thumb = document.getElementById('frame-thumb');
        if (thumb && filename) thumb.src = `/media/${p.id}/uploads/${encodeURIComponent(filename)}?t=${Date.now()}`;
      } else if (updated.status === 'failed' || updated.status === 'cancelled') {
        es.close();
        btn.disabled = false;
        btn.textContent = 'Apply with Qwen →';
        document.querySelector(`[data-qwen-job="${jobId}"]`)?.remove();
        alert('Qwen edit failed: ' + (updated.error || updated.status));
      }
    };
    es.onerror = () => {
      es.close();
      btn.disabled = false;
      btn.textContent = 'Apply with Qwen →';
      document.querySelector(`[data-qwen-job="${jobId}"]`)?.remove();
    };
  } catch (err) {
    alert('Qwen edit failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Apply with Qwen →';
  }
});

// ── Compare toggle ─────────────────────────────────────────────
let _compareMode = false;
const _compareWrap  = document.getElementById('preview-compare-wrap');
const _compareSrc   = document.getElementById('compare-source-area');
const _compareVid   = document.getElementById('compare-source-video');
const _compareLabelGen = document.getElementById('compare-label-gen');
const _btnCompare   = document.getElementById('btn-compare');

document.getElementById('btn-compare').addEventListener('click', () => {
  _compareMode = !_compareMode;
  _btnCompare.classList.toggle('active', _compareMode);
  _compareSrc.hidden        = !_compareMode;
  _compareLabelGen.hidden   = !_compareMode;

  if (_compareMode) {
    // Detect orientation from the current video element
    const vid = document.getElementById('preview-video');
    const isLandscape = vid.videoWidth > 0 && vid.videoWidth >= vid.videoHeight;
    _compareWrap.classList.toggle('compare-landscape', isLandscape);
  }
});

// Sync pause/play to compare source — timeupdate doesn't fire while paused
document.getElementById('preview-video')?.addEventListener('pause', () => {
  if (_compareMode) _compareVid.pause();
});
document.getElementById('preview-video')?.addEventListener('play', () => {
  if (_compareMode) _compareVid.play().catch(() => {});
});

document.addEventListener('player:timeupdate', e => {
  if (!_compareMode) return;
  const { currentTime, clipId } = e.detail;
  const p = state.project;
  if (!p) return;
  const clip = p.sourceClips.find(c => c.id === clipId);
  if (!clip) return;

  const srcUrl = `/media/${p.id}/uploads/${encodeURIComponent(clip.filename)}`;
  const targetSrc = new URL(srcUrl, location.href).href;

  if (!_compareVid.src || new URL(_compareVid.src, location.href).href !== targetSrc) {
    _compareVid.src = srcUrl;
    _compareVid.addEventListener('loadedmetadata', () => {
      _compareVid.currentTime = currentTime;
    }, { once: true });
  } else if (Math.abs(_compareVid.currentTime - currentTime) > 0.5) {
    _compareVid.currentTime = currentTime;
  }

  const mainVid = document.getElementById('preview-video');
  if (!mainVid.paused && _compareVid.paused) _compareVid.play().catch(() => {});
  if (mainVid.paused && !_compareVid.paused) _compareVid.pause();
});

// ── Segment → show its job in the right panel ──────────────────
document.addEventListener('segment:showjob', e => {
  const { segId } = e.detail;
  // Find the most recent job that produced or is producing this segment
  const segJobs = [..._jobs.values()]
    .filter(j => j.params?.segId === segId)
    .sort((a, b) => new Date(b.queuedAt ?? 0) - new Date(a.queuedAt ?? 0));
  const job = segJobs[0];
  if (job) showJobInPanel(job.id);
});

// ── Export button ──────────────────────────────────────────────
function updateExportButton() {
  const p   = state.project;
  const btn = document.getElementById('btn-export');
  if (!btn) return;
  btn.disabled = !p?.segments.some(s => s.generatedVideo);
}

document.getElementById('btn-export')?.addEventListener('click', () => {
  document.getElementById('export-modal').hidden = false;
});

document.getElementById('btn-export-cancel')?.addEventListener('click', () => {
  document.getElementById('export-modal').hidden = true;
});

document.getElementById('export-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('export-modal'))
    document.getElementById('export-modal').hidden = true;
});

document.getElementById('btn-export-confirm')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const modal   = document.getElementById('export-modal');
  const confirm = document.getElementById('btn-export-confirm');
  const includeAudio = document.getElementById('export-audio-check').checked;
  modal.hidden = true;
  confirm.loading = true;
  confirm.disabled = true;
  try {
    const res = await fetch(`/api/project/${p.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeAudio }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Export failed'); return; }
    const a = document.createElement('a');
    a.href     = data.path;
    a.download = `${p.name || 'export'}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.error('Export error:', e);
  } finally {
    confirm.loading = false;
    updateExportButton();
  }
});

// ── Timeline toolbar buttons ───────────────────────────────────
document.getElementById('btn-split')?.addEventListener('click', async () => {
  const tlFrame = window._selectedTLFrame;
  if (tlFrame == null) {
    alert('Place the cursor on the ruler first, then split.');
    return;
  }
  const p = state.project;
  if (!p) return;

  const info = getFrameInfo(tlFrame);
  if (!info) return;

  try {
    const res = await fetch(`/api/project/${p.id}/segments/${info.segId}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atSourceFrame: info.clipFrame }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Split failed'); return; }
    state.project = data.project;
    timelineSetProject(data.project);
    updateGenerateButton();
  } catch (e) {
    console.error('Split error:', e);
  }
});

async function saveSegmentSelections(project) {
  await fetch(`/api/project/${project.id}/segments-bulk`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: project.segments.map(s => ({ id: s.id, selected: s.selected })) }),
  });
}

document.getElementById('btn-select-all')?.addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  p.segments.forEach(s => { s.selected = true; });
  timelineSetProject(p);
  updateGenerateButton();
  saveSegmentSelections(p);
});

document.getElementById('btn-select-none')?.addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  p.segments.forEach(s => { s.selected = false; });
  timelineSetProject(p);
  updateGenerateButton();
  saveSegmentSelections(p);
});

document.getElementById('btn-select-ungenerated')?.addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  p.segments.forEach(s => { s.selected = !s.generatedVideo; });
  timelineSetProject(p);
  updateGenerateButton();
  saveSegmentSelections(p);
});

// ── Boot ───────────────────────────────────────────────────────
initProject();
