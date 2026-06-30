import { state } from './state.js';
import { timelineSetProject, timelineSetJobs, timelineClearSelection, timelineRedraw, timelinePatchSegment, getFrameInfo } from './timeline.js';
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
  const useSourceFpsEl = document.getElementById('use-source-fps');
  if (useSourceFpsEl) {
    useSourceFpsEl.checked = !!p.useSourceFps;
    if (gfpsEl) gfpsEl.disabled = !!p.useSourceFps;
  }
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
  const resEl = document.getElementById('gen-resolution');
  if (resEl) resEl.value = String(p.megapixels ?? '0.5');
  const retryEl = document.getElementById('retry-on-failure');
  if (retryEl) retryEl.checked = !!p.retryOnFailure;
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
  renderProjJobsDefault();
  _syncProjElapsedTimer();
  mobApply();
  _mobLoadLatestRender();
  _fetchProjJobsHistory(p.id);
}

async function _fetchProjJobsHistory(projectId) {
  try {
    const res  = await fetch(`/api/project/${projectId}/jobs`);
    if (!res.ok) return;
    const { jobs } = await res.json();
    const map = new Map(jobs.map(j => [j.id, j]));
    _projJobsHistory.set(projectId, map);
    renderProjJobsDefault();
  } catch {}
}

function updateSegDurationHint(p) {
  const hint = document.getElementById('seg-duration-hint');
  if (!hint) return;
  const genFrms = p?.genFramesPerSegment ?? 81;
  if (p?.useSourceFps) {
    const clip = p.sourceClips?.[0];
    if (clip?.fps) {
      const sec = (genFrms / clip.fps).toFixed(1);
      hint.textContent = `${genFrms} frames ÷ ${clip.fps.toFixed(2)}fps (source) = ~${sec}s per segment`;
    } else {
      hint.textContent = `${genFrms} frames ÷ source fps`;
    }
    return;
  }
  const genFps  = p?.genFps  ?? 8;
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

// Duplicate current project
document.getElementById('btn-duplicate-project').addEventListener('click', async () => {
  const id = localStorage.getItem('motionStudioProjectId');
  if (!id) return;
  const res = await fetch(`/api/project/${id}/duplicate`, { method: 'POST' });
  if (!res.ok) { alert('Duplicate failed'); return; }
  const p = await res.json();
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
    // Sort: by segmentIndex, then original before 2x, then version
    const sorted = [...assets].sort((a, b) => {
      if ((a.segmentIndex ?? 0) !== (b.segmentIndex ?? 0)) return (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0);
      if (!!a.is2x !== !!b.is2x) return a.is2x ? 1 : -1;
      return (a.version ?? 0) - (b.version ?? 0);
    });
    sorted.forEach(asset => {
      const seg    = p.segments.find(s => s.id === asset.segId);
      const segNum = (asset.segmentIndex ?? 0) + 1;
      const label  = asset.is2x ? `Seg ${segNum} 2x` : (asset.version === 0 ? `Seg ${segNum}` : `Seg ${segNum}.${asset.version}`);
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
  document.getElementById('seg-props').hidden           = true;
  document.getElementById('asset-props').hidden         = false;
  _setPanelDetail(name);

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
  document.getElementById('gen-modal-resolution').value = String(p.megapixels ?? '0.5');
  document.getElementById('gen-modal-retry').checked = p.retryOnFailure ?? true;
  document.getElementById('gen-modal-count').textContent = n;
  document.getElementById('generate-modal').hidden  = false;
  document.getElementById('gen-modal-prompt').focus();
});

document.getElementById('gen-modal-auto-render')?.addEventListener('change', e => {
  const opts = document.getElementById('gen-modal-render-opts');
  if (opts) opts.style.display = e.target.checked ? 'flex' : 'none';
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
  const clipId = p.segments[0]?.sourceClipId;
  const clip = p.sourceClips.find(c => c.id === clipId) ?? p.sourceClips[0];
  if (!clip) return;

  const name       = document.getElementById('gen-modal-name').value.trim() || 'untitled';
  const mode       = document.getElementById('gen-modal-mode').value;
  const prompt     = document.getElementById('gen-modal-prompt').value.trim();
  const resolution        = document.getElementById('gen-modal-resolution').value;
  const retryOnFail       = document.getElementById('gen-modal-retry').checked;
  const autoRenderOnFinish = document.getElementById('gen-modal-auto-render').checked;
  const includeAudio      = document.getElementById('gen-modal-audio').checked;
  const use2xUpscale      = document.getElementById('gen-modal-upscale').checked;
  const use2xFps          = document.getElementById('gen-modal-rife').checked;

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
        megapixels: resolution,
        retryOnFailure: retryOnFail,
        autoRenderOnFinish,
        includeAudio,
        use2xUpscale,
        use2xFps,
        segIds: p.segments.filter(s => s.selected).map(s => s.id),
      }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to queue generation'); return; }
    [...data.jobs].reverse().forEach(watchJob);
    // Force-reconnect SSE so it dumps current job states (may have already transitioned from pending)
    _forceReconnectStream();
  } catch (e) {
    console.error('Generate error:', e);
  }
});

// ── Toast notifications ────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  const dismiss = () => {
    el.classList.add('fade-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  setTimeout(dismiss, duration);
  el.addEventListener('click', dismiss);
}

// ── Job log panel ──────────────────────────────────────────────
const _jobs = new Map(); // jobId → job object (live SSE state)
const _projJobsHistory = new Map(); // projectId → Map<jobId, job> (fetched from server)
let _sortAsc = localStorage.getItem('logsSortAsc') !== 'false';

// Track in-flight Qwen jobs so the global SSE can handle their completion
const _pendingQwenJobs = new Map(); // jobId → true

// The Qwen job currently tied to the "Apply with Qwen" button
let _activeQwenJobId = null;

// Estimated generation time: ~10 min per 81 frames, linear scale
const _SECS_PER_FRAME = 600 / 81;
// Qwen image edit typically finishes in 1–1.5 min
const _QWEN_ESTIMATED_SECS = 90;

const _RIFE2X_ESTIMATED_SECS = 120;

function _estimatePct(job) {
  if (!job.startedAt) return '~0%';
  const elapsed   = (Date.now() - new Date(job.startedAt)) / 1000;
  const isQwen    = job.params?.jobType === 'qwen-edit';
  const isRife2x  = job.params?.jobType === 'rife-2x';
  const estimated = isQwen ? _QWEN_ESTIMATED_SECS : isRife2x ? _RIFE2X_ESTIMATED_SECS : (job.params?.frameCount ?? 81) * _SECS_PER_FRAME;
  return `~${Math.min(99, Math.round((elapsed / estimated) * 100))}%`;
}

// Tick all visible running-job percentage displays every second
setInterval(() => {
  document.querySelectorAll('.job-card[data-status="running"] .job-pct').forEach(el => {
    const startedAt = el.dataset.startedAt;
    if (!startedAt) return;
    const elapsed   = (Date.now() - new Date(startedAt)) / 1000;
    const isQwen    = !!el.dataset.isQwen;
    const isRife2x  = !!el.dataset.isRife2x;
    const estimated = isQwen ? _QWEN_ESTIMATED_SECS : isRife2x ? _RIFE2X_ESTIMATED_SECS : (parseInt(el.dataset.frameCount, 10) || 81) * _SECS_PER_FRAME;
    el.textContent  = `~${Math.min(99, Math.round((elapsed / estimated) * 100))}%`;
  });
  // Redraw timeline to tick running-segment progress bars
  if ([..._jobs.values()].some(j => j.status === 'running')) {
    timelineRedraw();
  }
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

  const isQwen       = job.params?.jobType === 'qwen-edit';
  const isRife2x       = job.params?.jobType === 'rife-2x';
  const isRifeSegment  = job.params?.jobType === 'rife-segment';
  const isEsrgan       = job.params?.jobType === 'esrgan-2x';
  const isAutoRender   = job.params?.jobType === 'auto-render';
  const jobLabel = isRife2x
    ? '2x FPS'
    : isRifeSegment
    ? `Seg ${(job.params?.segmentIndex ?? 0) + 1} 2x FPS`
    : isAutoRender
    ? 'Auto Render'
    : isEsrgan
    ? `Seg ${(job.params?.segmentIndex ?? 0) + 1} 2x`
    : isQwen
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
    ? `<span class="job-pct" data-started-at="${job.startedAt ?? ''}" data-frame-count="${job.params?.frameCount ?? 81}"${isQwen ? ' data-is-qwen="1"' : ''}${isRife2x ? ' data-is-rife2x="1"' : ''}>${_estimatePct(job)}</span>`
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
  renderProjJobsDefault();
  _syncProjElapsedTimer();
  mobApply();
}

// Single global SSE — replaces per-job EventSource streams
let _globalStream = null;
function _forceReconnectStream() {
  if (_globalStream) { _globalStream.close(); _globalStream = null; }
  ensureGlobalStream();
}
function ensureGlobalStream() {
  if (_globalStream && _globalStream.readyState !== EventSource.CLOSED) return;
  _globalStream = new EventSource('/api/jobs/stream');
  _globalStream.onmessage = e => {
    const updated = JSON.parse(e.data);
    _jobs.set(updated.id, { ...(_jobs.get(updated.id) ?? {}), ...updated });
    renderJob(updated);

    // Keep "Apply with Qwen" button in sync with the active Qwen job's status
    if (updated.id === _activeQwenJobId) {
      const btn = document.getElementById('btn-apply-qwen');
      if (btn) {
        if (updated.status === 'waiting') {
          btn.textContent = 'WAITING…';
        } else if (updated.status === 'running') {
          btn.textContent = 'RUNNING…';
        } else if (['done', 'failed', 'cancelled'].includes(updated.status)) {
          btn.disabled = false;
          btn.textContent = 'Apply with Qwen →';
          _activeQwenJobId = null;
        }
      }
    }

    if (updated.status === 'done') {
      onJobDone(updated);
      if (_pendingQwenJobs.has(updated.id)) {
        onQwenDone(updated);
        _pendingQwenJobs.delete(updated.id);
      }
    } else if (updated.status === 'failed' && _pendingQwenJobs.has(updated.id)) {
      showToast('Qwen edit failed: ' + (updated.error || 'unknown error'), 'error', 6000);
      document.querySelector(`[data-qwen-job="${updated.id}"]`)?.remove();
      _pendingQwenJobs.delete(updated.id);
    }
  };
}

async function onQwenDone(job) {
  const p = state.project;
  if (!p || p.id !== job.params?.projectId) return;
  document.querySelector(`[data-qwen-job="${job.id}"]`)?.remove();
  const proj = await fetch(`/api/project/${p.id}`).then(r => r.json());
  state.project = proj;
  renderAssetList();
  const filename = job.result?.outputPath?.split('/').pop();
  const thumb = document.getElementById('frame-thumb');
  if (thumb && filename) thumb.src = `/media/${p.id}/uploads/${encodeURIComponent(filename)}?t=${Date.now()}`;
  showToast('Qwen edit complete', 'success');
}

function watchJob(job) {
  _jobs.set(job.id, job);
  renderJob(job);
  if (['done', 'failed', 'cancelled'].includes(job.status)) return;
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
  const jsonToggle = e.target.closest('.job-json-toggle');
  if (jsonToggle) {
    const pre = document.getElementById(`job-json-${jsonToggle.dataset.jobId}`);
    if (pre) {
      pre.hidden = !pre.hidden;
      jsonToggle.textContent = pre.hidden ? '▾ Get JSON Input' : '▴ Get JSON Input';
    }
    return;
  }

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

function onRife2xDone(job) {
  const output    = job.result?.outputPath;
  const projectId = job.params?.projectId;
  if (!output || !projectId) return;
  const outputFile = output.split('/').pop();
  const path = `/media/${projectId}/generated/${encodeURIComponent(outputFile)}`;
  showToast('2x FPS render complete', 'success', 8000);
  const p = state.project;
  if (p?.id === projectId) {
    _mobShowRenderHero(path, p.name);
  }
}

async function onJobDone(job) {
  if (job.params?.jobType === 'rife-2x') {
    onRife2xDone(job);
    return;
  }
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
  mobApply();
  const segNum = (job.params?.segmentIndex ?? 0) + 1;
  showToast(`Segment ${segNum} generation complete`, 'success');

  // Auto-render when all segments are done and no more generation jobs are in flight
  const allDone = project.segments.length > 0 && project.segments.every(s => s.generatedVideo);
  const stillRunning = [..._jobs.values()].some(j =>
    j.params?.projectId === projectId &&
    j.params?.jobType !== 'qwen-edit' &&
    j.params?.jobType !== 'rife-2x' &&
    _ACTIVE_STATUSES.has(j.status)
  );
  if (allDone && !stillRunning) {
    showToast('All segments done — auto-rendering…', 'info', 5000);
    const includeAudio = document.getElementById('export-audio-check')?.checked ?? true;
    const use2xFps     = document.getElementById('export-2xfps-check')?.checked ?? true;
    try {
      const r    = await fetch(`/api/project/${project.id}/export`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ includeAudio, use2xFps }),
      });
      const data = await r.json();
      if (!r.ok) { showToast(data.error || 'Auto-render failed', 'error'); return; }
      if (data.rife2xPending) {
        watchJob(data.job);
      } else {
        _mobShowRenderHero(data.path, project.name);
      }
    } catch (e) {
      showToast('Auto-render failed: ' + e.message, 'error');
    }
  }
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
  document.getElementById('seg-props').hidden            = true;
  document.getElementById('job-props').hidden            = false;

  const isQwen   = job.params?.jobType === 'qwen-edit';
  const isRife2x = job.params?.jobType === 'rife-2x';
  const seg      = (job.params?.segmentIndex ?? 0) + 1;
  const label    = isRife2x
    ? `2x FPS Render — ${job.status}`
    : isQwen
    ? `Frame ${job.params?.frameIndex ?? '?'}${job.params?.nsfw ? ' (NSFW)' : ''} — ${job.status}`
    : `Segment ${seg} — ${job.status}`;
  _setPanelDetail(label);

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
    ${job.comfyWorkflow ? `<div class="asset-props-row"><a class="job-result-link job-json-toggle" data-job-id="${job.id}">▾ Get JSON Input</a></div><pre class="job-json-pre" id="job-json-${job.id}" hidden>${escHtml(JSON.stringify(job.comfyWorkflow, null, 2))}</pre>` : ''}
    ${canCancel ? `<div class="job-cancel-row"><button class="job-cancel-btn" data-job-id="${job.id}">✕ Cancel Job</button></div>` : ''}
    ${(canCancel || job.status === 'failed') ? `<div class="job-cancel-row"><button class="job-retry-btn" data-job-id="${job.id}">↺ Retry Job</button></div>` : ''}
  `;

  let specificRows;
  if (isRife2x) {
    specificRows = `
      <div class="asset-props-row"><span>Type</span><span>2x FPS (RIFE)</span></div>
    `;
  } else if (isQwen) {
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

// ── Right panel navigation ─────────────────────────────────────
function _setPanelDetail(title) {
  document.getElementById('right-panel-title').textContent = title;
  document.getElementById('right-panel-header').classList.add('detail-mode');
  document.getElementById('panel-back-btn').hidden = false;
  document.getElementById('proj-jobs-panel').hidden = true;
}

function showProjJobsDefault() {
  document.getElementById('job-props').hidden           = true;
  document.getElementById('asset-props').hidden         = true;
  document.getElementById('frame-props-content').hidden = true;
  document.getElementById('frame-props-empty').hidden   = true;
  document.getElementById('seg-props').hidden           = true;
  document.getElementById('proj-jobs-panel').hidden     = false;
  document.getElementById('right-panel-title').textContent = 'Properties';
  document.getElementById('right-panel-header').classList.remove('detail-mode');
  document.getElementById('panel-back-btn').hidden = true;
  document.querySelectorAll('.asset-item.active, .job-card.active, .proj-job-item.active')
    .forEach(el => el.classList.remove('active'));
  _clearElapsedTimer();
}

document.getElementById('panel-back-btn')?.addEventListener('click', showProjJobsDefault);

const _ACTIVE_STATUSES = new Set(['running', 'waiting', 'pending', 'paused']);

function _projJobProgress(job) {
  if (!job.startedAt) return '~0% | 0s';
  const elapsed  = (Date.now() - new Date(job.startedAt)) / 1000;
  const jobType  = job.params?.jobType ?? '';
  const estimated = jobType === 'rife-2x' ? _RIFE2X_ESTIMATED_SECS
    : (job.params?.frameCount ?? 81) * _SECS_PER_FRAME;
  const pct = Math.min(99, Math.round((elapsed / estimated) * 100));
  return `~${pct}% | ${_fmtElapsed(job.startedAt, null)}`;
}

setInterval(() => {
  document.querySelectorAll('#proj-jobs-list .proj-job-progress').forEach(el => {
    const startedAt = el.dataset.startedAt;
    if (!startedAt) return;
    const elapsed   = (Date.now() - new Date(startedAt)) / 1000;
    const jobType   = el.dataset.jobType ?? '';
    const estimated = jobType === 'rife-2x' ? _RIFE2X_ESTIMATED_SECS
      : (parseInt(el.dataset.frameCount, 10) || 81) * _SECS_PER_FRAME;
    const pct = Math.min(99, Math.round((elapsed / estimated) * 100));
    el.textContent = `~${pct}% | ${_fmtElapsed(startedAt, null)}`;
  });
}, 1000);

function renderProjJobsDefault() {
  const listEl = document.getElementById('proj-jobs-list');
  if (!listEl || document.getElementById('proj-jobs-panel').hidden) return;
  const p = state.project;
  if (!p) { listEl.innerHTML = '<div class="proj-jobs-empty">No project loaded</div>'; return; }

  // Merge historical (fetched from server) with live SSE jobs; live wins on conflict
  const histMap  = _projJobsHistory.get(p.id) ?? new Map();
  const merged   = new Map(histMap);
  for (const [id, job] of _jobs) if (job.params?.projectId === p.id) merged.set(id, job);
  const projJobs = [...merged.values()]
    .filter(j => j.params?.jobType !== 'qwen-edit');

  if (!projJobs.length) {
    listEl.innerHTML = '<div class="proj-jobs-empty">No generation runs for this project</div>';
    return;
  }

  const activeJobId = listEl.querySelector('.proj-job-item.active')?.dataset.jobId;

  // Build timeline offsets from project segments (mirrors segLayout in timeline.js)
  const segs = p.segments || [];
  let tlOffset = 0;
  const segTimes = segs.map(seg => {
    const clip = (p.sourceClips || []).find(c => c.id === seg.sourceClipId);
    const fps  = clip?.fps || 30;
    const start = tlOffset / fps;
    const end   = (tlOffset + seg.frameCount) / fps;
    tlOffset += seg.frameCount;
    return { start, end };
  });

  const bySegAsc  = (a, b) => (a.params?.segmentIndex ?? 0) - (b.params?.segmentIndex ?? 0);
  const byNewest  = (a, b) => new Date(b.queuedAt ?? 0) - new Date(a.queuedAt ?? 0);

  const _RENDER_TYPES = new Set(['rife-2x', 'auto-render']);
  const renderJobs  = projJobs.filter(j => _RENDER_TYPES.has(j.params?.jobType)).sort(byNewest);
  const segJobs     = projJobs.filter(j => !_RENDER_TYPES.has(j.params?.jobType));

  // Within a segment: gen job first, then esrgan-2x, then rife-segment
  const _segTypeOrder = t => t === 'esrgan-2x' ? 1 : t === 'rife-segment' ? 2 : 0;
  const bySegAndType  = (a, b) => {
    const sd = (a.params?.segmentIndex ?? 0) - (b.params?.segmentIndex ?? 0);
    return sd !== 0 ? sd : _segTypeOrder(a.params?.jobType) - _segTypeOrder(b.params?.jobType);
  };

  const activeSegs  = segJobs.filter(j =>  _ACTIVE_STATUSES.has(j.status)).sort(bySegAndType);
  const doneSegs    = segJobs.filter(j => !_ACTIVE_STATUSES.has(j.status)).sort(bySegAndType);

  const renderItem = job => {
    const jobType      = job.params?.jobType;
    const isRife2x     = jobType === 'rife-2x';
    const isAutoRender = jobType === 'auto-render';
    const isEsrgan     = jobType === 'esrgan-2x';
    const isRifeSeg    = jobType === 'rife-segment';
    const active       = job.id === activeJobId ? ' active' : '';
    let label, extra = '';
    if (isRife2x) {
      label = '2x FPS Render';
      if (job.status === 'done' && job.result?.outputPath) {
        const pid  = job.params?.projectId;
        const file = job.result.outputPath.split('/').pop();
        extra = `<a class="proj-job-download" href="/media/${pid}/generated/${encodeURIComponent(file)}" download="${escHtml(file)}" onclick="event.stopPropagation()">↓ Download</a>`;
      }
    } else if (isAutoRender) {
      label = 'Auto Render';
    } else {
      const idx   = job.params?.segmentIndex ?? 0;
      const times = segTimes[idx];
      const range = times ? ` | ${times.start.toFixed(1)}s – ${times.end.toFixed(1)}s` : '';
      const suffix = isEsrgan ? ' 2x' : isRifeSeg ? ' 2x FPS' : '';
      label = `Segment ${idx + 1}${suffix}${range}`;
    }
    const isRunning = job.status === 'running';
    const progressSpan = isRunning
      ? `<span class="proj-job-progress" data-started-at="${job.startedAt ?? ''}" data-frame-count="${job.params?.frameCount ?? 81}" data-job-type="${job.params?.jobType ?? ''}">${_projJobProgress(job)}</span>`
      : '';
    let elapsed = '';
    if (job.startedAt && job.completedAt) {
      const secs = Math.round((new Date(job.completedAt) - new Date(job.startedAt)) / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      elapsed = `<span class="proj-job-elapsed">${m > 0 ? `${m}m ` : ''}${s}s</span>`;
    }
    return `<div class="proj-job-item${active}" data-job-id="${job.id}">
      <span class="proj-job-label">${escHtml(label)}</span>
      ${progressSpan}${elapsed}<span class="job-badge job-badge-${job.status}">${job.status}</span>
      ${extra}
    </div>`;
  };

  const segDivider = (activeSegs.length > 0 && doneSegs.length > 0)
    ? '<div class="jobs-separator">done</div>'
    : '';
  const renderDivider = renderJobs.length > 0 && (activeSegs.length + doneSegs.length) > 0
    ? '<hr class="jobs-section-hr">'
    : '';

  listEl.innerHTML =
    renderJobs.map(renderItem).join('') +
    renderDivider +
    activeSegs.map(renderItem).join('') +
    segDivider +
    doneSegs.map(renderItem).join('');

  listEl.querySelectorAll('.proj-job-item').forEach(item => {
    item.addEventListener('click', () => {
      listEl.querySelectorAll('.proj-job-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      showJobInPanel(item.dataset.jobId);
    });
  });
}

// ── Frame select → right panel ─────────────────────────────────
let _selectedSegIdForFrame = null;

document.addEventListener('frame:select', async e => {
  const { clipId, frameIndex } = e.detail;
  state.selectedFrame = { clipId, frameIndex };

  document.querySelectorAll('.asset-item.active').forEach(el => el.classList.remove('active'));
  document.getElementById('job-props').hidden           = true;
  document.getElementById('asset-props').hidden         = true;
  document.getElementById('frame-props-empty').hidden   = true;
  document.getElementById('seg-props').hidden           = true;
  document.getElementById('frame-props-content').hidden = false;
  _setPanelDetail('Frame Properties');

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

document.getElementById('use-source-fps')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  const checked = e.target.checked;
  document.getElementById('gen-fps').disabled = checked;
  const res = await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ useSourceFps: checked }),
  });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  updateSegDurationHint(project);
  timelineSetProject(project);
  updateGenerateButton();
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

document.getElementById('gen-resolution')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ megapixels: e.target.value }),
  });
});

document.getElementById('retry-on-failure')?.addEventListener('change', async e => {
  if (_applyingProject) return;
  const p = state.project;
  if (!p) return;
  await fetch(`/api/project/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ retryOnFailure: e.target.checked }),
  });
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
  timelinePatchSegment(seg.id, { selected: seg.selected });
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
  const overlay = document.getElementById('timeline-loading-overlay');
  if (overlay) overlay.hidden = false;
  try {
    const res = await fetch(`/api/project/${p.id}/clips/${clipId}/segments`, { method: 'POST' });
    if (!res.ok) return;
    const { project } = await res.json();
    state.project = project;
    timelineSetProject(project);
    playerBuildPlaylist(project.segments, project.id, project.sourceClips);
    updateGenerateButton();
  } finally {
    if (overlay) overlay.hidden = true;
  }
});

let _selectedSegId = null;
document.addEventListener('segment:select', e => {
  _selectedSegId = e.detail.segId;
  if (_selectedSegId) _showSegProps(_selectedSegId);
  else showProjJobsDefault();
});

function _showSegProps(segId) {
  const p = state.project;
  if (!p) return;
  const seg = p.segments.find(s => s.id === segId);
  if (!seg) return;

  // Determine if this is the first segment of its clip
  const clipsSegs   = p.segments.filter(s => s.sourceClipId === seg.sourceClipId);
  const isFirstOfClip = clipsSegs[0]?.id === seg.id;
  const segIdx      = p.segments.indexOf(seg) + 1;

  document.getElementById('job-props').hidden           = true;
  document.getElementById('asset-props').hidden         = true;
  document.getElementById('frame-props-empty').hidden   = true;
  document.getElementById('frame-props-content').hidden = true;
  document.getElementById('seg-props').hidden           = false;
  _setPanelDetail(`Segment ${segIdx}`);

  // Enabled checkbox
  const enabledCb = document.getElementById('seg-props-enabled');
  enabledCb.checked = seg.selected !== false;

  // Workflow checkbox
  const extendCb  = document.getElementById('seg-props-extend');
  const extendRow = document.getElementById('seg-props-extend-row');
  const badge     = document.getElementById('seg-props-workflow-label');

  if (isFirstOfClip) {
    extendCb.checked  = false;
    extendCb.disabled = true;
    extendRow.classList.add('seg-props-disabled');
    badge.textContent = 'Base Motion (first segment)';
    badge.className   = 'seg-props-workflow-badge seg-props-badge-base';
  } else {
    extendCb.disabled = false;
    extendRow.classList.remove('seg-props-disabled');
    extendCb.checked  = !(seg.useBaseWorkflow ?? false);
    const isBase      = seg.useBaseWorkflow ?? false;
    badge.textContent = isBase ? 'Base Motion' : 'Extended Motion';
    badge.className   = `seg-props-workflow-badge ${isBase ? 'seg-props-badge-base' : 'seg-props-badge-extend'}`;
  }

  // Wire up enabled toggle (replace listeners by cloning)
  const newEnabled = enabledCb.cloneNode(true);
  enabledCb.replaceWith(newEnabled);
  newEnabled.addEventListener('change', async () => {
    seg.selected = newEnabled.checked;
    timelinePatchSegment(seg.id, { selected: seg.selected });
    updateGenerateButton();
    await fetch(`/api/project/${p.id}/segments/${seg.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: seg.selected }),
    });
  });

  // Wire up workflow toggle
  const newExtend = extendCb.cloneNode(true);
  extendCb.replaceWith(newExtend);
  if (!isFirstOfClip) {
    newExtend.addEventListener('change', async () => {
      seg.useBaseWorkflow = !newExtend.checked;
      const isBase  = seg.useBaseWorkflow;
      badge.textContent = isBase ? 'Base Motion' : 'Extended Motion';
      badge.className   = `seg-props-workflow-badge ${isBase ? 'seg-props-badge-base' : 'seg-props-badge-extend'}`;
      timelinePatchSegment(seg.id, { useBaseWorkflow: seg.useBaseWorkflow });
      await fetch(`/api/project/${p.id}/segments/${seg.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useBaseWorkflow: seg.useBaseWorkflow }),
      });
    });
  }
}
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
  btn.textContent = 'Queuing…';
  try {
    const res = await fetch(`/api/project/${p.id}/frame-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId, frameIndex, prompt, supportImage: _supportImageFilename, nsfw }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Qwen edit failed to queue', 'error');
      btn.disabled = false;
      btn.textContent = 'Apply with Qwen →';
      return;
    }

    const jobId = data.jobId;
    _activeQwenJobId = jobId;

    // Keep button disabled in WAITING state — SSE will update to RUNNING then re-enable on done/fail
    btn.textContent = 'WAITING…';

    // Add pulsing placeholder in Uploads panel
    const uploadsList = document.getElementById('uploads-list');
    const placeholder = document.createElement('div');
    placeholder.className = 'asset-item qwen-placeholder';
    placeholder.dataset.qwenJob = jobId;
    placeholder.innerHTML = '<span>Generating in Qwen…</span>';
    if (uploadsList) uploadsList.prepend(placeholder);

    // Register for completion via the shared global SSE
    _pendingQwenJobs.set(jobId, true);
    ensureGlobalStream();

    showToast('Qwen edit queued — button re-enables when done', 'info', 5000);
  } catch (err) {
    showToast('Qwen edit failed: ' + err.message, 'error');
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
  document.getElementById('export-audio-check').checked  = true;
  document.getElementById('export-2xfps-check').checked  = true;
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
  const modal      = document.getElementById('export-modal');
  const confirm    = document.getElementById('btn-export-confirm');
  const includeAudio  = document.getElementById('export-audio-check').checked;
  const use2xUpscale  = document.getElementById('export-upscale-check')?.checked ?? true;
  const use2xFps      = document.getElementById('export-2xfps-check').checked;
  modal.hidden = true;
  confirm.loading = true;
  confirm.disabled = true;
  try {
    const res = await fetch(`/api/project/${p.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeAudio, use2xUpscale, use2xFps }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Render failed'); return; }
    if (data.rife2xPending) {
      watchJob(data.job);
      showToast('2x FPS render queued — check Project Generations for progress', 'info', 6000);
    } else {
      const a = document.createElement('a');
      a.href     = data.path;
      a.download = `${p.name || 'export'}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
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

document.getElementById('btn-clear-segments')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p || !p.segments.length) return;
  if (!confirm(`Remove all ${p.segments.length} segment(s)? This cannot be undone.`)) return;
  const res = await fetch(`/api/project/${p.id}/segments`, { method: 'DELETE' });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  timelineClearSelection();
  applyProject();
});

// ── Mobile view ────────────────────────────────────────────────
function _mobBuildSegBody(pid, segIdx, asset, job) {
  const status = job?.status ?? (asset ? 'done' : null);
  let mediaHtml = '';
  if (asset) {
    mediaHtml = `<video class="mob-seg-video" data-src="/media/${pid}/generated/${encodeURIComponent(asset.filename)}" muted playsinline controls preload="none"></video>`;
  } else if (status === 'running') {
    mediaHtml = `<div class="mob-seg-pulse">Generating…</div>`;
  } else if (status === 'waiting') {
    mediaHtml = `<div class="mob-seg-idle" style="color:#b45309">Up next — ComfyUI busy</div>`;
  } else if (status === 'pending') {
    mediaHtml = `<div class="mob-seg-idle">Pending in queue…</div>`;
  } else if (status === 'failed') {
    mediaHtml = `<div class="mob-seg-idle" style="color:#b91c1c">Generation failed</div>`;
  } else {
    mediaHtml = `<div class="mob-seg-idle">Not generated yet</div>`;
  }
  if (!job) return mediaHtml;

  const durSec    = (job.params?.frameCount && job.params?.genFps) ? (job.params.frameCount / job.params.genFps).toFixed(1) : null;
  const isLive    = status === 'running' && job.startedAt && !job.completedAt;
  const elapsed   = _fmtElapsed(job.startedAt, job.completedAt);
  const canCancel = ['pending','waiting','running'].includes(status);
  const canRetry  = ['pending','waiting','running','failed'].includes(status);
  const fmtT      = iso => iso ? new Date(iso).toLocaleTimeString() : '—';

  const rows = [
    ['Frames',  job.params?.frameCount ?? '—'],
    durSec      ? ['Duration', `${durSec}s`] : null,
    ['Start frame', job.params?.startFrame ?? 0],
    ['Seed',    job.params?.seed ?? '—'],
    ['Started', fmtT(job.startedAt)],
    ['Elapsed', isLive
      ? `<span class="mob-elapsed" data-started-at="${job.startedAt}">${elapsed}</span>`
      : elapsed],
    job.error   ? ['Error', `<span style="color:#b91c1c;word-break:break-word">${escHtml(job.error)}</span>`] : null,
  ].filter(Boolean).map(([l, v]) => `<div class="mob-seg-row"><span>${l}</span><span>${v}</span></div>`).join('');

  const actHtml = (canCancel || canRetry) ? `
    <div class="mob-job-actions">
      ${canCancel ? `<button class="mob-cancel-btn" data-job-id="${job.id}">✕ Cancel</button>` : ''}
      ${canRetry  ? `<button class="mob-retry-btn"  data-job-id="${job.id}">↺ Retry</button>`  : ''}
    </div>` : '';

  return `${mediaHtml}<div class="mob-seg-details">${rows}${actHtml}</div>`;
}

function mobApply() {
  if (!window.matchMedia('(max-width:767px)').matches) return;
  const p      = state.project;
  const nameEl = document.getElementById('mob-proj-name');
  const bodyEl = document.getElementById('mob-body');
  const genBtn = document.getElementById('mob-btn-generate');
  const expBtn = document.getElementById('mob-btn-export');
  if (!nameEl || !bodyEl) return;

  if (!p) {
    nameEl.textContent = 'Loading…';
    bodyEl.innerHTML   = '<div class="mob-empty">Loading project…</div>';
    if (genBtn) genBtn.disabled = true;
    if (expBtn) expBtn.disabled = true;
    return;
  }

  nameEl.textContent = p.name || 'untitled';

  // Merge historical + live jobs; live wins on conflict
  const histMap  = _projJobsHistory.get(p.id) ?? new Map();
  const merged   = new Map(histMap);
  for (const [id, job] of _jobs) if (job.params?.projectId === p.id) merged.set(id, job);
  const projJobs = [...merged.values()].filter(j => j.params?.jobType !== 'qwen-edit');

  const latestAsset = new Map();
  (p.generatedAssets ?? []).forEach(a => {
    const cur = latestAsset.get(a.segmentIndex);
    if (!cur || a.version > cur.version) latestAsset.set(a.segmentIndex, a);
  });

  const badgeClass = { done:'mob-badge-done', running:'mob-badge-running', waiting:'mob-badge-waiting', pending:'mob-badge-pending', failed:'mob-badge-failed', cancelled:'mob-badge-failed', paused:'mob-badge-paused' };
  const badgeLabel = { done:'Done', running:'Running', waiting:'Waiting', pending:'Pending', failed:'Failed', cancelled:'Cancelled', paused:'Paused' };

  if (!projJobs.length && latestAsset.size === 0) {
    bodyEl.innerHTML = '<div class="mob-empty">No segments yet. Upload a source clip first.</div>';
  } else {
    const _RENDER_JOB_TYPES = new Set(['rife-2x', 'auto-render']);
    const _segTypeOrder = t => t === 'esrgan-2x' ? 1 : t === 'rife-segment' ? 2 : 0;
    const renderJobs = projJobs.filter(j =>  _RENDER_JOB_TYPES.has(j.params?.jobType))
                                .sort((a, b) => new Date(a.queuedAt ?? 0) - new Date(b.queuedAt ?? 0));
    const segJobs    = projJobs.filter(j => !_RENDER_JOB_TYPES.has(j.params?.jobType))
                                .sort((a, b) => {
                                  const sd = (a.params?.segmentIndex ?? 0) - (b.params?.segmentIndex ?? 0);
                                  return sd !== 0 ? sd : _segTypeOrder(a.params?.jobType) - _segTypeOrder(b.params?.jobType);
                                });

    const mobJobLabel = job => {
      const t   = job.params?.jobType;
      const idx = job.params?.segmentIndex ?? 0;
      const n   = idx + 1;
      if (t === 'rife-2x')     return '2x FPS Render';
      if (t === 'auto-render') return 'Auto Render';
      if (t === 'esrgan-2x')   return `S${n} 2x`;
      if (t === 'rife-segment') return `S${n} 2x FPS`;
      return `S${n}`;
    };

    const renderJobRow = job => {
      const status  = job.status;
      const badge   = badgeClass[status] ? `<span class="mob-badge ${badgeClass[status]}">${badgeLabel[status] ?? status}</span>` : '';
      let elapsed = '';
      if (job.startedAt && job.completedAt) {
        const secs = Math.round((new Date(job.completedAt) - new Date(job.startedAt)) / 1000);
        const m = Math.floor(secs / 60), s = secs % 60;
        elapsed = `<span class="mob-job-elapsed">${m > 0 ? `${m}m ` : ''}${s}s</span>`;
      } else if (status === 'running' && job.startedAt) {
        elapsed = `<span class="mob-elapsed" data-started-at="${job.startedAt}"></span>`;
      }
      return `<div class="mob-job-row">
        <span class="mob-job-row-label">${escHtml(mobJobLabel(job))}</span>
        ${elapsed}${badge}
      </div>`;
    };

    bodyEl.innerHTML = [...segJobs, ...renderJobs].map(renderJobRow).join('') ||
      '<div class="mob-empty">No generation runs yet.</div>';
  }

  const hasUngenerated = (p.segments ?? []).some(s => !s.generatedVideo);
  const hasGenerated   = latestAsset.size > 0 || (p.segments ?? []).some(s => s.generatedVideo);
  if (genBtn) genBtn.disabled = !hasUngenerated;
  if (expBtn) expBtn.disabled = !hasGenerated;

  // Live elapsed tick for running jobs
  const hasActive = projJobs.some(j => ['pending','waiting','running'].includes(j.status));
  if (hasActive && !window._mobElapsedTimer) {
    window._mobElapsedTimer = setInterval(() => {
      document.querySelectorAll('.mob-elapsed[data-started-at]').forEach(el => {
        el.textContent = _fmtElapsed(el.dataset.startedAt, null);
      });
    }, 1000);
  } else if (!hasActive && window._mobElapsedTimer) {
    clearInterval(window._mobElapsedTimer);
    window._mobElapsedTimer = null;
  }

  _mobPrependRenderHero();
}

// Cancel / Retry delegation on mob-body (wired once)
document.getElementById('mob-body')?.addEventListener('click', async e => {
  const cancelBtn = e.target.closest('.mob-cancel-btn');
  if (cancelBtn) {
    cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…';
    const res = await fetch(`/api/jobs/${cancelBtn.dataset.jobId}`, { method: 'DELETE' });
    if (res.ok) { const { job } = await res.json(); watchJob(job); }
    else { cancelBtn.disabled = false; cancelBtn.textContent = '✕ Cancel'; }
    return;
  }
  const retryBtn = e.target.closest('.mob-retry-btn');
  if (retryBtn) {
    retryBtn.disabled = true; retryBtn.textContent = 'Retrying…';
    const res = await fetch(`/api/jobs/${retryBtn.dataset.jobId}/retry`, { method: 'POST' });
    if (res.ok) { const { job: newJob } = await res.json(); watchJob(newJob); }
    else { retryBtn.disabled = false; retryBtn.textContent = '↺ Retry'; }
  }
});

document.getElementById('mob-btn-generate')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const clip = p.sourceClips[0];
  if (!clip) return;
  const ungenerated = p.segments.filter(s => !s.generatedVideo);
  if (!ungenerated.length) return;
  const btn = document.getElementById('mob-btn-generate');
  btn.disabled = true; btn.textContent = 'Queuing…';
  try {
    const res = await fetch(`/api/project/${p.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: clip.id, segIds: ungenerated.map(s => s.id) }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to queue generation'); return; }
    [...data.jobs].reverse().forEach(watchJob);
    _forceReconnectStream();
    showToast(`Queued ${data.jobs.length} segment(s)`, 'success');
  } catch (e) {
    console.error('Mobile generate error:', e);
  } finally {
    btn.textContent = 'Generate →';
    mobApply();
  }
});

let _mobRenderPath = null;
let _mobRenderName = null;

function _mobShowRenderHero(path, projectName) {
  _mobRenderPath = path;
  _mobRenderName = projectName || 'export';
  _mobPrependRenderHero();
}

function _mobPrependRenderHero() {
  const bodyEl = document.getElementById('mob-body');
  if (!bodyEl || !_mobRenderPath) return;
  const existing = bodyEl.querySelector('.mob-render-hero');
  if (existing) { existing.remove(); }
  const hero = document.createElement('div');
  hero.className = 'mob-render-hero';
  hero.innerHTML = `
    <video class="mob-render-video" src="${_mobRenderPath}" muted playsinline controls></video>
    <button class="mob-render-download-btn">↓ Download</button>`;
  hero.querySelector('.mob-render-download-btn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = _mobRenderPath; a.download = `${_mobRenderName}.mp4`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  bodyEl.prepend(hero);
}

async function _mobLoadLatestRender() {
  const p = state.project;
  if (!p) return;
  try {
    const res = await fetch(`/api/project/${p.id}/exports`);
    if (!res.ok) return;
    const { exports } = await res.json();
    if (exports?.length) {
      _mobShowRenderHero(`/media/${p.id}/generated/${encodeURIComponent(exports[0])}`, p.name);
    }
  } catch { /* ignore */ }
}

document.getElementById('mob-btn-export')?.addEventListener('click', () => {
  document.getElementById('mob-export-audio-check').checked = true;
  document.getElementById('mob-export-2xfps-check').checked = true;
  document.getElementById('mob-export-modal').hidden = false;
});

document.getElementById('mob-export-cancel')?.addEventListener('click', () => {
  document.getElementById('mob-export-modal').hidden = true;
});

document.getElementById('mob-export-confirm')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const includeAudio  = document.getElementById('mob-export-audio-check').checked;
  const use2xFps      = document.getElementById('mob-export-2xfps-check').checked;
  const use2xUpscale  = document.getElementById('mob-export-upscale-check')?.checked ?? true;
  const modal         = document.getElementById('mob-export-modal');
  const confirmBtn    = document.getElementById('mob-export-confirm');
  const renderBtn     = document.getElementById('mob-btn-export');

  modal.hidden = true;
  confirmBtn.disabled = true;
  renderBtn.disabled = true; renderBtn.textContent = 'Rendering…';

  try {
    const res = await fetch(`/api/project/${p.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeAudio, use2xFps, use2xUpscale }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Render failed', 'error'); return; }
    if (data.rife2xPending) {
      watchJob(data.job);
      showToast('2x FPS render queued — download will appear here when done', 'info', 6000);
    } else {
      _mobShowRenderHero(data.path, p.name);
      showToast('Render complete', 'success');
    }
  } catch (e) {
    showToast('Render failed: ' + e.message, 'error');
  } finally {
    confirmBtn.disabled = false;
    renderBtn.disabled = false; renderBtn.textContent = 'Render';
  }
});

// ── Project elapsed timer ──────────────────────────────────────
let _projElapsedTimer = null;

function _projEtaInfo() {
  const p = state.project;
  if (!p) return null;
  const projJobs = [..._jobs.values()].filter(j =>
    j.params?.projectId === p.id && j.params?.jobType !== 'qwen-edit'
  );
  if (!projJobs.length) return null;

  let totalElapsed = 0;
  let totalEstimated = 0;
  let hasRunning = false;

  for (const j of projJobs) {
    const jobType  = j.params?.jobType ?? '';
    const est = jobType === 'rife-2x' ? _RIFE2X_ESTIMATED_SECS
      : (j.params?.frameCount ?? 81) * _SECS_PER_FRAME;
    totalEstimated += est;

    if (j.status === 'done' && j.startedAt && j.completedAt) {
      totalElapsed += (new Date(j.completedAt) - new Date(j.startedAt)) / 1000;
    } else if (j.status === 'running' && j.startedAt) {
      totalElapsed += (Date.now() - new Date(j.startedAt)) / 1000;
      hasRunning = true;
    }
  }
  return { totalElapsed, totalEstimated, hasRunning };
}

function _tickProjElapsed() {
  const el = document.getElementById('proj-elapsed-label');
  if (!el) return;
  const info = _projEtaInfo();
  if (!info || info.totalElapsed === 0) { el.textContent = ''; return; }

  const { totalElapsed, totalEstimated } = info;
  const pct = totalEstimated > 0 ? Math.min(99, Math.round((totalElapsed / totalEstimated) * 100)) : null;
  const fmt = secs => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m > 0 ? `${m}m` : `${s}s`;
  };
  const elStr  = fmt(totalElapsed);
  const estStr = totalEstimated > 0 ? `~${fmt(totalEstimated)}` : null;
  el.textContent = estStr && pct != null
    ? `${elStr} / ${estStr} (~${pct}%)`
    : elStr;
}

function _syncProjElapsedTimer() {
  const p = state.project;
  const projJobs = p ? [..._jobs.values()].filter(j =>
    j.params?.projectId === p.id && j.params?.jobType !== 'qwen-edit'
  ) : [];
  const hasRunning = projJobs.some(j => j.status === 'running' || j.status === 'waiting' || j.status === 'pending');

  _tickProjElapsed();

  if (hasRunning && !_projElapsedTimer) {
    _projElapsedTimer = setInterval(_tickProjElapsed, 1000);
  } else if (!hasRunning && _projElapsedTimer) {
    clearInterval(_projElapsedTimer);
    _projElapsedTimer = null;
  }
}

// ── Pause / Resume all jobs ────────────────────────────────────
function _setQueuePausedUI(paused) {
  const btn = document.getElementById('btn-pause-all');
  if (!btn) return;
  btn.classList.toggle('paused', paused);
  document.getElementById('pause-icon').hidden  = paused;
  document.getElementById('resume-icon').hidden = !paused;
  const lbl = document.getElementById('pause-all-label');
  if (lbl) lbl.textContent = paused ? 'Resume' : 'Pause Pending';
}

fetch('/api/queue-status').then(r => r.json()).then(d => _setQueuePausedUI(d.paused)).catch(() => {});

document.getElementById('btn-upscale-done')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const btn = document.getElementById('btn-upscale-done');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/project/${p.id}/upscale-segments`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Upscale failed', 'error'); return; }
    if (data.jobs.length === 0) {
      showToast(`All segments already upscaled (${data.skipped} skipped)`, 'info');
      return;
    }
    [...data.jobs].reverse().forEach(watchJob);
    _forceReconnectStream();
    showToast(`Queued ${data.jobs.length} upscale job(s)${data.skipped ? `, ${data.skipped} already done` : ''}`, 'success');
  } catch (e) {
    showToast('Upscale error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-pause-all')?.addEventListener('click', async () => {
  const isPaused = document.getElementById('btn-pause-all').classList.contains('paused');
  const res = await fetch(`/api/jobs/${isPaused ? 'resume' : 'pause'}-all`, { method: 'POST' });
  if (res.ok) {
    const { paused } = await res.json();
    _setQueuePausedUI(paused);
    showToast(paused ? 'Queue paused' : 'Queue resumed', paused ? 'info' : 'success');
  }
});

document.getElementById('btn-clear-pending')?.addEventListener('click', () => {
  document.getElementById('clear-pending-modal').hidden = false;
});

document.getElementById('btn-clear-pending-cancel')?.addEventListener('click', () => {
  document.getElementById('clear-pending-modal').hidden = true;
});

document.getElementById('btn-clear-pending-confirm')?.addEventListener('click', async () => {
  const modal = document.getElementById('clear-pending-modal');
  const btn   = document.getElementById('btn-clear-pending-confirm');
  modal.hidden = true;
  btn.disabled = true;
  try {
    const res  = await fetch('/api/jobs/cancel-pending', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to cancel jobs', 'error'); return; }
    showToast(`Cancelled ${data.cancelled} pending job${data.cancelled === 1 ? '' : 's'}`, 'success');
    setTimeout(() => document.getElementById('btn-refresh-logs')?.click(), 400);
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Asset browser ─────────────────────────────────────────────
let _abRoot      = null;
let _abSubpath   = '';
let _abSort      = 'name';
let _abView      = 'grid';
let _abPage      = 1;
let _abFilter    = '';
let _abRoots     = [];
let _abLastData  = null;
let _abSelected  = null; // { name, type }
const _abThumbCache   = new Map();  // url → jpeg dataURL
let   _abThumbObserver = null;
const _abCaptureQueue  = [];
let   _abCapturePending = 0;
const _AB_CONCURRENT   = 4;

function _abDrainCaptures() {
  while (_abCapturePending < _AB_CONCURRENT && _abCaptureQueue.length) {
    const { url, cb } = _abCaptureQueue.shift();
    _abCapturePending++;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    let done = false;
    const finish = (dataUrl) => {
      if (done) return; done = true;
      v.src = ''; v.load();
      _abCapturePending--;
      if (dataUrl) { _abThumbCache.set(url, dataUrl); cb(dataUrl); }
      _abDrainCaptures();
    };
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = isFinite(v.duration) && v.duration > 1 ? 1 : 0;
    }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 200;
        c.getContext('2d').drawImage(v, 0, 0, 320, 200);
        finish(c.toDataURL('image/jpeg', 0.75));
      } catch { finish(null); }
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    setTimeout(() => finish(null), 12000);
    v.src = url;
  }
}

function _abQueueThumb(url, cb) {
  if (_abThumbCache.has(url)) { cb(_abThumbCache.get(url)); return; }
  _abCaptureQueue.push({ url, cb });
  _abDrainCaptures();
}

function _abObserveVideos(body) {
  if (_abThumbObserver) _abThumbObserver.disconnect();
  _abThumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      _abThumbObserver.unobserve(entry.target);
      const wrap = entry.target;
      const url  = wrap.dataset.videoUrl;
      if (!url) continue;
      _abQueueThumb(url, (dataUrl) => {
        const vid = wrap.querySelector('video');
        if (vid) vid.poster = dataUrl;
      });
    }
  }, { threshold: 0.1 });
  body.querySelectorAll('.ab-video-wrap[data-video-url]').forEach(w => _abThumbObserver.observe(w));
}

function _abFileUrl(name) {
  return `/api/asset-browser-file?root=${encodeURIComponent(_abRoot)}&subpath=${encodeURIComponent(_abSubpath)}&name=${encodeURIComponent(name)}`;
}

function _abClearPreview() {
  _abSelected = null;
  const panel = document.getElementById('asset-browser-preview');
  if (panel) panel.innerHTML = `<div class="ab-preview-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="color:var(--sl-color-neutral-300)"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 21h18"/></svg><p>Click a file to preview</p></div>`;
}

async function _abLoad(root, subpath = '', page = 1) {
  _abRoot    = root;
  _abSubpath = subpath;
  _abPage    = page;
  _abLastData = null;
  _abClearPreview();
  const body   = document.getElementById('asset-browser-body');
  const status = document.getElementById('asset-browser-status');
  if (body) body.innerHTML = '<div class="asset-browser-empty">Loading…</div>';
  if (status) status.textContent = '';
  try {
    const url = `/api/asset-browser?root=${encodeURIComponent(root)}&subpath=${encodeURIComponent(subpath)}&sort=${_abSort}&page=${page}&perPage=60`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok) { if (body) body.innerHTML = `<div class="asset-browser-empty">${escHtml(data.error || 'Error')}</div>`; return; }
    _abLastData = data;
    _abRenderBreadcrumb(root, subpath);
    _abRenderItems(data);
  } catch (err) {
    if (body) body.innerHTML = `<div class="asset-browser-empty">Failed: ${escHtml(err.message)}</div>`;
  }
}

function _abRenderBreadcrumb(root, subpath) {
  const bc = document.getElementById('asset-browser-breadcrumb');
  if (!bc) return;
  const rootLabel = _abRoots.find(r => r.key === root)?.label ?? root;
  if (!subpath) { bc.innerHTML = ''; bc.hidden = true; return; }
  const parts = subpath.split('/').filter(Boolean);
  const crumbs = [`<button class="ab-crumb" data-path="">⌂ ${escHtml(rootLabel)}</button>`];
  parts.forEach((p, i) => {
    const path = parts.slice(0, i + 1).join('/');
    crumbs.push(`<span class="ab-crumb-sep">›</span><button class="ab-crumb" data-path="${escHtml(path)}">${escHtml(p)}</button>`);
  });
  bc.innerHTML = crumbs.join('');
  bc.hidden = false;
  bc.querySelectorAll('.ab-crumb').forEach(btn => {
    btn.addEventListener('click', () => _abLoad(_abRoot, btn.dataset.path, 1));
  });
}

function _abRenderItems(data) {
  const body   = document.getElementById('asset-browser-body');
  const pager  = document.getElementById('asset-browser-pagination');
  const status = document.getElementById('asset-browser-status');
  if (!body) return;

  const filter = _abFilter.toLowerCase();
  const dirs   = (data.dirs ?? []).filter(d => !filter || d.toLowerCase().includes(filter));
  const items  = filter ? data.items.filter(i => i.name.toLowerCase().includes(filter)) : data.items;

  if (!dirs.length && !items.length) {
    body.innerHTML = '<div class="asset-browser-empty">No files found</div>';
    if (pager)  pager.innerHTML  = '';
    if (status) status.textContent = '';
    return;
  }

  const isGrid = _abView === 'grid';
  body.className = `asset-browser-body${isGrid ? ' ab-grid' : ' ab-list'}`;

  const dirHTML = dirs.map(d => `
    <div class="ab-item ab-dir" data-dir="${escHtml(d)}" title="${escHtml(d)}">
      <div class="ab-dir-icon">
        <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
      </div>
      <span class="ab-item-name">${escHtml(d)}</span>
    </div>`).join('');

  const fileHTML = items.map(item => {
    const fileUrl = _abFileUrl(item.name);
    const isImg   = item.type === 'image';
    const media   = isImg
      ? `<img class="ab-thumb" src="${escHtml(fileUrl)}" loading="lazy" alt="">`
      : `<div class="ab-video-wrap" data-video-url="${escHtml(fileUrl)}">
           <video class="ab-video-thumb" src="${escHtml(fileUrl)}" muted preload="none" loop playsinline></video>
           <div class="ab-video-play-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M8 5v14l11-7z"/></svg></div>
         </div>`;
    return `<div class="ab-item" data-name="${escHtml(item.name)}" data-type="${item.type}" title="${escHtml(item.name)}">
      ${media}
      <span class="ab-item-name">${escHtml(item.name)}</span>
    </div>`;
  }).join('');

  body.innerHTML = dirHTML + fileHTML;
  _abObserveVideos(body);

  // Folder navigation
  body.querySelectorAll('.ab-dir').forEach(el => {
    el.addEventListener('click', () => {
      const next = _abSubpath ? `${_abSubpath}/${el.dataset.dir}` : el.dataset.dir;
      _abFilter = '';
      const searchEl = document.getElementById('asset-browser-search');
      if (searchEl) searchEl.value = '';
      _abLoad(_abRoot, next, 1);
    });
  });

  // Video hover preview
  body.querySelectorAll('.ab-video-thumb').forEach(vid => {
    const wrap = vid.closest('.ab-video-wrap');
    wrap?.addEventListener('mouseenter', () => { vid.play().catch(() => {}); wrap.querySelector('.ab-video-play-icon').style.opacity = '0'; });
    wrap?.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; wrap.querySelector('.ab-video-play-icon').style.opacity = '1'; });
  });

  // File → preview panel on click
  body.querySelectorAll('.ab-item:not(.ab-dir)').forEach(el => {
    el.addEventListener('click', () => {
      body.querySelectorAll('.ab-item.ab-selected').forEach(i => i.classList.remove('ab-selected'));
      el.classList.add('ab-selected');
      _abPreview(el.dataset.name, el.dataset.type);
    });
  });

  if (pager) {
    const { page, totalPages } = data;
    const pages = [];
    if (page > 1) pages.push(`<button class="ab-page-btn" data-page="${page - 1}">‹ Prev</button>`);
    if (totalPages > 1) pages.push(`<span class="ab-page-info">${page} / ${totalPages}</span>`);
    if (page < totalPages) pages.push(`<button class="ab-page-btn" data-page="${page + 1}">Next ›</button>`);
    pager.innerHTML = pages.join('');
    pager.querySelectorAll('.ab-page-btn').forEach(btn => {
      btn.addEventListener('click', () => _abLoad(_abRoot, _abSubpath, parseInt(btn.dataset.page, 10)));
    });
  }
  const total = data.total + (data.dirs?.length ?? 0);
  if (status) status.textContent = `${dirs.length} folder${dirs.length !== 1 ? 's' : ''}, ${data.total} file${data.total !== 1 ? 's' : ''}`;
}

function _abPreview(name, type) {
  _abSelected = { name, type };
  const panel  = document.getElementById('asset-browser-preview');
  if (!panel) return;
  const fileUrl = _abFileUrl(name);
  const media   = type === 'image'
    ? `<img class="ab-preview-media" src="${escHtml(fileUrl)}" alt="${escHtml(name)}">`
    : `<video class="ab-preview-media" src="${escHtml(fileUrl)}" controls muted playsinline></video>`;
  panel.innerHTML = `
    ${media}
    <div class="ab-preview-name" title="${escHtml(name)}">${escHtml(name)}</div>
    <button class="btn btn-primary ab-preview-import-btn" id="btn-ab-import">↓ Import</button>
  `;
  document.getElementById('btn-ab-import').addEventListener('click', () => {
    if (_abSelected) _abImport(_abSelected.name, _abSelected.type);
  });
}

async function _abImport(filename, type) {
  const p = state.project;
  if (!p) return;
  const status = document.getElementById('asset-browser-status');
  if (status) status.textContent = `Importing ${filename}…`;
  try {
    const res  = await fetch(`/api/project/${p.id}/import-from-server`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ root: _abRoot, subpath: _abSubpath, filename }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Import failed', 'error'); if (status) status.textContent = ''; return; }
    state.project = data.project;
    applyProject();
    showToast(`Imported: ${filename}`, 'success');
    if (status) status.textContent = `Imported ${filename}`;
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
    if (status) status.textContent = '';
  }
}

async function openAssetBrowser() {
  const modal = document.getElementById('asset-browser-modal');
  if (!modal) return;
  modal.hidden = false;

  if (!_abRoots.length) {
    const res  = await fetch('/api/asset-browser');
    const data = await res.json();
    _abRoots   = data.roots ?? [];
    const tabs = document.getElementById('asset-browser-tabs');
    if (tabs) {
      tabs.innerHTML = _abRoots.map((r, i) =>
        `<button class="ab-tab${i === 0 ? ' active' : ''}" data-root="${escHtml(r.key)}">${escHtml(r.label)}</button>`
      ).join('');
      tabs.querySelectorAll('.ab-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          tabs.querySelectorAll('.ab-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          _abFilter = '';
          const searchEl = document.getElementById('asset-browser-search');
          if (searchEl) searchEl.value = '';
          _abClearPreview();
          _abLoad(btn.dataset.root, '', 1);
        });
      });
    }
  }

  if (_abRoots.length && !_abRoot) {
    _abLoad(_abRoots[0].key, '', 1);
  }
}

document.getElementById('btn-browse-server')?.addEventListener('click', e => {
  e.stopPropagation();
  openAssetBrowser();
});

document.getElementById('btn-asset-browser-close')?.addEventListener('click', () => {
  document.getElementById('asset-browser-modal').hidden = true;
});

document.getElementById('asset-browser-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('asset-browser-modal'))
    document.getElementById('asset-browser-modal').hidden = true;
});

function _abSyncSortBtns() {
  document.querySelectorAll('#ab-sort-group .pg-ctrl-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.absort === _abSort);
  });
}

document.getElementById('ab-sort-group')?.addEventListener('click', e => {
  const btn = e.target.closest('.pg-ctrl-btn[data-absort]');
  if (!btn) return;
  _abSort = btn.dataset.absort;
  _abSyncSortBtns();
  if (_abRoot) _abLoad(_abRoot, _abSubpath, 1);
});

let _abSearchTimer = null;
document.getElementById('asset-browser-search')?.addEventListener('input', e => {
  clearTimeout(_abSearchTimer);
  _abSearchTimer = setTimeout(() => {
    _abFilter = e.target.value.trim();
    if (_abLastData) _abRenderItems(_abLastData);
    else if (_abRoot) _abLoad(_abRoot, _abSubpath, 1);
  }, 200);
});

document.getElementById('asset-browser-view-grid')?.addEventListener('click', () => {
  _abView = 'grid';
  document.getElementById('asset-browser-view-grid').classList.add('active');
  document.getElementById('asset-browser-view-list').classList.remove('active');
  if (_abLastData) _abRenderItems(_abLastData);
});

document.getElementById('asset-browser-view-list')?.addEventListener('click', () => {
  _abView = 'list';
  document.getElementById('asset-browser-view-list').classList.add('active');
  document.getElementById('asset-browser-view-grid').classList.remove('active');
  if (_abLastData) _abRenderItems(_abLastData);
});

// ── Boot ───────────────────────────────────────────────────────
initProject();
