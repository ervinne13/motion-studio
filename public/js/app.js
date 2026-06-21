import { state } from './state.js';
import { timelineSetProject, timelineClearSelection, timelineRedraw, getFrameInfo } from './timeline.js';
import { playerLoadClip, playerSeek, playerSetGenSegments, playerToggleGenSeg } from './player.js';

// Per-segment overlay visibility — read by timeline.js draw to dim hidden segments
window._hiddenGenSegIds = new Set();

// ── Project init ───────────────────────────────────────────────
async function initProject() {
  const stored = localStorage.getItem('motionStudioProjectId');

  if (stored) {
    try {
      const res = await fetch(`/api/project/${stored}`);
      if (res.ok) {
        state.project = await res.json();
        applyProject();
        await restoreJobs();
        return;
      }
    } catch { /* fall through */ }
  }

  const res = await fetch('/api/project', { method: 'POST' });
  state.project = await res.json();
  localStorage.setItem('motionStudioProjectId', state.project.id);
  applyProject();
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
  // Sync settings panel fields (guard prevents sl-change from firing a PATCH)
  const gfpsEl = document.getElementById('gen-fps');
  if (gfpsEl) gfpsEl.value = String(p.genFps ?? 24);
  const gfrmEl = document.getElementById('gen-frames-per-segment');
  if (gfrmEl) gfrmEl.value = String(p.genFramesPerSegment ?? 81);
  // Reset flag after Shoelace finishes processing any queued microtasks
  setTimeout(() => { _applyingProject = false; }, 100);
  updateSegDurationHint(p);
  renderAssetList();
  timelineSetProject(p);
  updateGenerateButton();
  if (p.sourceClips.length > 0) {
    playerLoadClip(p.sourceClips[0], p.id);
    playerSetGenSegments(p.segments, p.id, p.sourceClips[0].fps);
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

  projects.forEach(p => {
    const card = document.createElement('div');
    const isActive = p.id === state.project?.id;
    card.className = `project-card${isActive ? ' active' : ''}`;
    card.dataset.id = p.id;

    const meta = [
      p.clipCount   ? `${p.clipCount} clip${p.clipCount   !== 1 ? 's' : ''}` : null,
      p.segmentCount ? `${p.segmentCount} seg${p.segmentCount !== 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ') || 'empty';

    card.innerHTML = `
      <div class="project-card-name">${escHtml(p.name || 'untitled')}</div>
      <div class="project-card-meta">${meta}</div>
      <button class="project-card-delete" title="Delete project" data-id="${p.id}">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
      </button>
    `;

    // Switch to project
    card.addEventListener('click', e => {
      if (e.target.closest('.project-card-delete')) return;
      if (isActive) { closeSwitcher(); return; }
      localStorage.setItem('motionStudioProjectId', p.id);
      location.reload();
    });

    // Delete project
    card.querySelector('.project-card-delete').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name || 'untitled'}"? This cannot be undone.`)) return;
      await fetch(`/api/project/${p.id}`, { method: 'DELETE' });
      if (p.id === state.project?.id) {
        localStorage.removeItem('motionStudioProjectId');
        location.reload();
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
  location.reload();
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
  const genSegs = p.segments.filter(s => s.generatedVideo);
  if (!genSegs.length) {
    genList.innerHTML = '<div class="empty-assets">No generated assets</div>';
  } else {
    genList.innerHTML = '';
    genSegs.forEach((seg, i) => {
      const item = document.createElement('div');
      item.className = 'asset-item';
      const pid = p.id;
      item.innerHTML = `<span class="asset-type-icon">🎬</span><a class="asset-name" href="/media/${pid}/generated/${encodeURIComponent(seg.generatedVideo)}" target="_blank" title="${escHtml(seg.generatedVideo)}">Seg ${i + 1}</a>`;
      genList.appendChild(item);
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
    if (isImage) e.dataTransfer.setData('application/x-ms-asset-image', name);
    e.dataTransfer.effectAllowed = 'copy';
  });

  if (isImage) {
    el.addEventListener('click', () => showAssetInPanel(name, thumbSrc, el));
  }

  return el;
}

function showAssetInPanel(name, src, itemEl) {
  // Deselect all
  document.querySelectorAll('.asset-item.active').forEach(e => e.classList.remove('active'));
  itemEl?.classList.add('active');

  // Hide frame props, show asset props
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

document.getElementById('btn-generate').addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const clip = p.sourceClips[0];
  if (!clip) return;

  // Switch to logs panel
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-panel="logs"]').classList.add('active');
  document.querySelectorAll('.panel-content').forEach(c => c.classList.remove('active'));
  document.getElementById('panel-logs').classList.add('active');

  try {
    const res = await fetch(`/api/project/${p.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: clip.id }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to queue generation'); return; }
    // data.jobs is an array — one entry per segment, in order
    // Render newest-batch at top: prepend in reverse so seg1 ends up on top
    [...data.jobs].reverse().forEach(watchJob);
  } catch (e) {
    console.error('Generate error:', e);
  }
});

// ── Job log panel ──────────────────────────────────────────────
const _jobs = new Map(); // jobId → job object
let _sortAsc = false; // false = newest first

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
  const btn = document.getElementById('btn-sort-logs');
  btn.classList.toggle('asc', _sortAsc);
  btn.title = _sortAsc ? 'Sort: oldest first' : 'Sort: newest first';
  sortJobList();
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

  const seg    = (job.params?.segmentIndex ?? 0) + 1;
  const status = job.status;
  const prog   = job.progress;

  const progLine = prog
    ? `<div class="job-progress">${prog.phase ?? ''} ${prog.done ?? 0}/${prog.total ?? '?'}</div>`
    : '';
  const errLine = job.error ? `<div class="job-error">${escHtml(job.error)}</div>` : '';

  const projName = job.params?.projectName ? `<span class="job-project">${escHtml(job.params.projectName)}</span>` : '';
  card.innerHTML = `
    <div class="job-row">
      <span class="job-label">Segment ${seg}${projName ? ' · ' : ''}${projName}</span>
      <span class="job-badge job-badge-${status}">${status}</span>
    </div>
    ${progLine}${errLine}
  `;

  // Pulse dot on logs icon when any job is active
  const anyActive = [..._jobs.values()].some(j => j.status === 'pending' || j.status === 'running');
  const pulse = document.getElementById('logs-pulse');
  if (pulse) pulse.hidden = !anyActive;

  if (isNew) sortJobList();
}

function watchJob(job) {
  renderJob(job);
  if (job.status === 'done') { onJobDone(job); return; }
  if (job.status === 'failed') return;

  const es = new EventSource(`/api/jobs/${job.id}/stream`);
  es.onmessage = e => {
    const updated = JSON.parse(e.data);
    renderJob(updated);
    if (updated.status === 'done') { onJobDone(updated); es.close(); }
    else if (updated.status === 'failed') es.close();
  };
  es.onerror = () => es.close();
}

async function onJobDone(job) {
  const segId    = job.params?.segId;
  const output   = job.result?.outputPath;
  const projectId = job.params?.projectId;
  if (!segId || !output || !projectId) return;

  const filename = output.split('/').pop();
  // Only PATCH if this job belongs to the currently open project
  const p = state.project;
  if (!p || p.id !== projectId) return;

  const res = await fetch(`/api/project/${p.id}/segments/${segId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generatedVideo: filename }),
  });
  if (!res.ok) return;
  const { project } = await res.json();
  state.project = project;
  timelineSetProject(project);
  renderAssetList();
  if (p.sourceClips.length > 0) playerSetGenSegments(project.segments, project.id, p.sourceClips[0].fps);
  updateExportButton();
}

// ── Job detail in right panel ──────────────────────────────────
function showJobInPanel(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return;

  document.querySelectorAll('.job-card').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-job-id="${jobId}"]`)?.classList.add('active');

  document.getElementById('asset-props').hidden          = true;
  document.getElementById('frame-props-empty').hidden    = true;
  document.getElementById('frame-props-content').hidden  = true;
  document.getElementById('job-props').hidden            = false;

  const seg = (job.params?.segmentIndex ?? 0) + 1;
  document.getElementById('right-panel-title').textContent = `Segment ${seg} — ${job.status}`;

  const p   = state.project;
  const ref = job.params?.referenceImageFilename;
  const img = document.getElementById('job-props-ref-img');
  img.src    = ref && p ? `/media/${p.id}/uploads/${encodeURIComponent(ref)}` : '';
  img.hidden = !ref;

  const durSec  = job.params ? (job.params.frameCount / job.params.genFps).toFixed(1) : '—';
  const queued  = (job.queuedAt || job.createdAt) ? new Date(job.queuedAt || job.createdAt).toLocaleTimeString() : '—';
  const started = job.startedAt   ? new Date(job.startedAt).toLocaleTimeString()   : '—';
  const elapsed = job.startedAt && job.completedAt
    ? `${((new Date(job.completedAt) - new Date(job.startedAt)) / 1000).toFixed(0)}s`
    : '—';

  const outputFile = job.result?.outputPath?.split('/').pop();
  const pid = job.params?.projectId;
  const outputLink = outputFile && pid
    ? `<a href="/media/${pid}/generated/${encodeURIComponent(outputFile)}" target="_blank" class="job-result-link">▶ View output</a>`
    : null;

  document.getElementById('job-props-details').innerHTML = `
    <div class="asset-props-row"><span>Status</span><span class="job-badge job-badge-${job.status}">${job.status}</span></div>
    <div class="asset-props-row"><span>Project</span><span>${escHtml(job.params?.projectName ?? '—')}</span></div>
    <div class="asset-props-row"><span>Segment #</span><span>${seg}</span></div>
    <div class="asset-props-row"><span>Frames</span><span>${job.params?.frameCount ?? '—'}</span></div>
    <div class="asset-props-row"><span>Gen FPS</span><span>${job.params?.genFps ?? '—'}</span></div>
    <div class="asset-props-row"><span>Duration</span><span>${durSec}s</span></div>
    <div class="asset-props-row"><span>Start frame</span><span>${job.params?.startFrame ?? 0}</span></div>
    <div class="asset-props-row"><span>Seed</span><span>${job.params?.seed ?? '—'}</span></div>
    <div class="asset-props-row"><span>Queued</span><span>${queued}</span></div>
    <div class="asset-props-row"><span>Started</span><span>${started}</span></div>
    <div class="asset-props-row"><span>Elapsed</span><span>${elapsed}</span></div>
    ${job.error ? `<div class="asset-props-row" style="color:#b91c1c"><span>Error</span><span style="word-break:break-word">${escHtml(job.error)}</span></div>` : ''}
    ${outputLink ? `<div class="asset-props-row">${outputLink}</div>` : ''}
  `;
}

// ── Frame select → right panel ─────────────────────────────────
document.addEventListener('frame:select', async e => {
  const { clipId, frameIndex } = e.detail;
  state.selectedFrame = { clipId, frameIndex };

  document.querySelectorAll('.asset-item.active').forEach(el => el.classList.remove('active'));
  document.getElementById('asset-props').hidden         = true;
  document.getElementById('right-panel-title').textContent = 'Frame Properties';
  document.getElementById('frame-props-empty').hidden   = true;
  document.getElementById('frame-props-content').hidden = false;

  const p    = state.project;
  const clip = p?.sourceClips.find(c => c.id === clipId);
  if (!clip) return;

  const thumb = document.getElementById('frame-thumb');
  thumb.src = '';
  try {
    const res = await fetch(`/api/project/${p.id}/thumbnails?clipId=${clipId}&start=${frameIndex}&end=${frameIndex}`);
    const { frames } = await res.json();
    if (frames.length) thumb.src = frames[0].url;
  } catch { /* leave blank */ }

  playerLoadClip(clip, p.id);
  playerSeek(frameIndex / clip.fps);
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
document.getElementById('project-name')?.addEventListener('sl-input', e => {
  if (!_applyingProject) setHeaderName(e.target.value || 'untitled');
});

document.getElementById('gen-fps')?.addEventListener('sl-change', async e => {
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

document.getElementById('gen-frames-per-segment')?.addEventListener('sl-change', async e => {
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

document.getElementById('project-name')?.addEventListener('sl-change', async e => {
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

document.addEventListener('segment:togglegen', e => {
  const { segId } = e.detail;
  if (window._hiddenGenSegIds.has(segId)) {
    window._hiddenGenSegIds.delete(segId);
  } else {
    window._hiddenGenSegIds.add(segId);
  }
  playerToggleGenSeg(segId);
  timelineRedraw();
});

let _selectedSegId = null;
document.addEventListener('segment:select', e => { _selectedSegId = e.detail.segId; });
document.getElementById('ctx-delete-seg').addEventListener('click', () => {
  if (_selectedSegId) deleteSegment(_selectedSegId);
});

// ── Support image drop zone ────────────────────────────────────
const supportZone = document.getElementById('support-drop-zone');
supportZone?.addEventListener('dragover',  e => { e.preventDefault(); supportZone.classList.add('drag-over'); });
supportZone?.addEventListener('dragleave', e => { if (!supportZone.contains(e.relatedTarget)) supportZone.classList.remove('drag-over'); });
supportZone?.addEventListener('drop',      e => { e.preventDefault(); supportZone.classList.remove('drag-over'); });

// ── Export button ──────────────────────────────────────────────
function updateExportButton() {
  const p   = state.project;
  const btn = document.getElementById('btn-export');
  if (!btn) return;
  btn.disabled = !p?.segments.some(s => s.generatedVideo);
}

document.getElementById('btn-export')?.addEventListener('click', async () => {
  const p = state.project;
  if (!p) return;
  const btn = document.getElementById('btn-export');
  btn.loading = true;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/project/${p.id}/export`, { method: 'POST' });
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
    btn.loading = false;
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

document.getElementById('btn-select-all')?.addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  p.segments.forEach(s => { s.selected = true; });
  timelineSetProject(p);
  updateGenerateButton();
});

document.getElementById('btn-select-none')?.addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  p.segments.forEach(s => { s.selected = false; });
  timelineSetProject(p);
  updateGenerateButton();
});

document.getElementById('btn-select-ungenerated')?.addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  p.segments.forEach(s => { s.selected = !s.generatedVideo; });
  timelineSetProject(p);
  updateGenerateButton();
});

// ── Boot ───────────────────────────────────────────────────────
initProject();
