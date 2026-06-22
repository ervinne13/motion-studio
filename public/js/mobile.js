// ── Utilities ────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function setView(html) {
  document.getElementById('view').innerHTML = html;
}

// ── Router ───────────────────────────────────────────────────────
let _detailTimer = null;

function stopPolling() {
  if (_detailTimer) { clearInterval(_detailTimer); _detailTimer = null; }
}

function route() {
  stopPolling();
  const hash = location.hash.slice(1);
  if (hash === 'projects') {
    renderProjects();
  } else if (hash.startsWith('project/')) {
    renderProjectDetail(hash.slice('project/'.length));
  } else {
    renderForm();
  }
}

window.addEventListener('hashchange', route);
route();

// ── Form view ────────────────────────────────────────────────────
let _projectId = null;
let _videoFile = null;
let _imageFile = null;

function renderForm() {
  const tpl = document.getElementById('tpl-form');
  const node = tpl.content.cloneNode(true);
  document.getElementById('view').innerHTML = '';
  document.getElementById('view').appendChild(node);

  const btnAdv   = document.getElementById('btn-advanced');
  const advPanel = document.getElementById('advanced-panel');
  btnAdv.addEventListener('click', () => {
    const open = advPanel.classList.toggle('open');
    btnAdv.classList.toggle('open', open);
  });

  wireZone('input-video', 'zone-video', 'video-name', true);
  wireZone('input-image', 'zone-image', 'image-name', false);

  document.getElementById('btn-generate').addEventListener('click', onGenerate);
}

function setStatus(msg, type = 'info') {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${type}`;
}
function clearStatus() {
  const el = document.getElementById('status-msg');
  if (el) el.className = 'status-msg';
}
function updateGenerateBtn() {
  const btn = document.getElementById('btn-generate');
  if (btn) btn.disabled = !(_videoFile && _imageFile);
}

const _ADJ  = ['active','amber','bold','calm','clever','cosmic','crisp','drifting','dusty','electric','frozen','gentle','golden','hollow','hungry','idle','jolly','late','lazy','lucky','melted','muted','narrow','neon','odd','pastel','quick','quiet','rainy','random','rapid','rogue','rough','rusty','shy','silent','silly','slim','slow','sneaky','soft','sour','swift','tiny','twisted','warm','wild','windy','wooden','young'];
const _NOUN = ['apple','badger','basket','bear','beetle','biscuit','bolt','candle','cloud','coin','coral','crow','dart','duck','engine','feather','fish','flame','fog','fox','frog','ghost','glacier','hammer','hedgehog','honey','kettle','lantern','leaf','lemon','lobster','marble','melon','mole','moon','moth','needle','noodle','otter','pebble','pickle','pigeon','pine','rabbit','raven','river','rocket','shadow','shark','snail','sparrow','spoon','storm','toast','torch','turnip','vessel','walrus','whistle','wolf'];
function _randomName() {
  return `${_ADJ[Math.floor(Math.random() * _ADJ.length)]} ${_NOUN[Math.floor(Math.random() * _NOUN.length)]}`;
}

async function ensureProject() {
  if (_projectId) return _projectId;
  const res = await fetch('/api/project', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create project');
  const data = await res.json();
  _projectId = data.id ?? data.project?.id;
  await fetch(`/api/project/${_projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: _randomName() }),
  });
  return _projectId;
}

function setZoneBusy(zoneId, busy, label = '') {
  const zone  = document.getElementById(zoneId);
  if (!zone) return;
  const input   = zone.querySelector('input[type=file]');
  const iconEl  = zone.querySelector('.upload-icon');
  if (busy) {
    zone.classList.add('busy');
    if (iconEl) { iconEl.dataset.origIcon = iconEl.textContent; iconEl.textContent = '↻'; }
    zone.querySelector('.upload-label').textContent = label || 'Uploading…';
    zone.querySelector('.upload-sub').textContent   = 'Please wait';
    if (input) input.disabled = true;
  } else {
    zone.classList.remove('busy');
    if (iconEl && iconEl.dataset.origIcon) iconEl.textContent = iconEl.dataset.origIcon;
    if (input) input.disabled = false;
  }
}

async function handleUpload(file, zoneId, nameId, isVideo) {
  const zone   = document.getElementById(zoneId);
  const nameEl = document.getElementById(nameId);

  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  setZoneBusy(zoneId, true, `Uploading ${sizeMB} MB…`);
  clearStatus();

  try {
    const id = await ensureProject();
    const fd = new FormData();
    fd.append('file', file);
    const res  = await fetch(`/api/project/${id}/upload`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    if (isVideo) {
      const clip = data.project.sourceClips.find(c => c.filename === file.name);
      _videoFile = { filename: file.name, clipId: clip?.id };
    } else {
      _imageFile = file.name;
      await fetch(`/api/project/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectReferenceImage: file.name }),
      });
    }

    setZoneBusy(zoneId, false);
    zone.classList.add('done');
    nameEl.textContent = file.name;
    nameEl.hidden = false;
    updateGenerateBtn();
  } catch (e) {
    setZoneBusy(zoneId, false);
    setStatus(e.message, 'error');
  }
}

function wireZone(inputId, zoneId, nameId, isVideo) {
  const input = document.getElementById(inputId);
  const zone  = document.getElementById(zoneId);

  input.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleUpload(file, zoneId, nameId, isVideo);
  });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file, zoneId, nameId, isVideo);
  });
}

async function onGenerate() {
  if (!_projectId || !_videoFile || !_imageFile) return;
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Queuing…';

  try {
    const id     = _projectId;
    const mode   = document.getElementById('sel-mode').value;
    const fps    = parseInt(document.getElementById('adv-fps').value, 10) || 24;
    const frames = parseInt(document.getElementById('adv-frames').value, 10) || 81;
    const prompt = document.getElementById('adv-prompt').value.trim();
    const seed   = parseInt(document.getElementById('adv-seed').value, 10);

    await fetch(`/api/project/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, genFps: fps, genFramesPerSegment: frames, defaultPrompt: prompt || '', defaultSeed: isNaN(seed) ? -1 : seed }),
    });

    await fetch(`/api/project/${id}/clips/${_videoFile.clipId}/segments`, { method: 'POST' });

    const genRes  = await fetch(`/api/project/${id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: _videoFile.clipId }),
    });
    const genData = await genRes.json();
    if (!genRes.ok) throw new Error(genData.error || 'Generation failed');

    const doneId = _projectId;
    _projectId = null; _videoFile = null; _imageFile = null;
    location.hash = `#project/${doneId}`;
  } catch (e) {
    setStatus(e.message, 'error');
    const btn2 = document.getElementById('btn-generate');
    if (btn2) { btn2.disabled = false; btn2.textContent = 'Generate'; }
  }
}

// ── Projects list ────────────────────────────────────────────────
async function renderProjects() {
  setView('<div class="mobile-loading">Loading…</div>');
  try {
    const res = await fetch('/api/projects');
    const { projects } = await res.json();

    if (!projects.length) {
      setView('<div class="mobile-empty">No projects yet — generate one!</div>');
      return;
    }

    const sorted = [...projects].sort((a, b) =>
      (a.name || 'untitled').localeCompare(b.name || 'untitled')
    );

    const items = sorted.map(p => {
      const sub = p.segmentCount
        ? `${p.doneCount}/${p.segmentCount} segments`
        : 'No segments';
      return `
        <a class="proj-item" href="#project/${p.id}">
          <span class="proj-item-name">${esc(p.name || 'untitled')}</span>
          <span class="proj-item-meta">${sub}</span>
          <span class="proj-item-arrow">›</span>
        </a>`;
    }).join('');

    setView(`<div class="proj-list">${items}</div>`);
  } catch {
    setView('<div class="mobile-empty">Failed to load projects.</div>');
  }
}

// ── Project detail ────────────────────────────────────────────────
async function renderProjectDetail(id) {
  setView('<div class="mobile-loading">Loading…</div>');
  try {
    await fetchAndPaintDetail(id);
  } catch {
    setView('<div class="mobile-empty">Failed to load project.</div>');
  }
}

async function fetchAndPaintDetail(id) {
  const [projRes, jobsRes, exportsRes] = await Promise.all([
    fetch(`/api/project/${id}`),
    fetch('/api/jobs'),
    fetch(`/api/project/${id}/exports`).catch(() => null),
  ]);
  if (!projRes.ok) { setView('<div class="mobile-empty">Project not found.</div>'); return; }

  const project     = await projRes.json();
  const { jobs }    = await jobsRes.json();
  const exportFiles = (exportsRes?.ok ? (await exportsRes.json()).exports : null) ?? [];
  const projJobs    = jobs.filter(j => j.params?.projectId === id && j.params?.jobType !== 'qwen-edit');

  paintProjectDetail(id, project, projJobs, exportFiles);

  const hasActive = projJobs.some(j => ['pending','waiting','running'].includes(j.status));
  if (hasActive && !_detailTimer) {
    _detailTimer = setInterval(() => pollDetail(id), 3000);
  }
}

// Polls job statuses and updates badges/videos in-place — never replaces the DOM
async function pollDetail(id) {
  if (location.hash !== `#project/${id}`) { stopPolling(); return; }

  const jobsRes = await fetch('/api/jobs').catch(() => null);
  if (!jobsRes?.ok) return;
  const { jobs } = await jobsRes.json();
  const projJobs = jobs.filter(j => j.params?.projectId === id && j.params?.jobType !== 'qwen-edit');

  const badgeClass = { done: 'mbadge-done', running: 'mbadge-running', waiting: 'mbadge-waiting', pending: 'mbadge-pending', failed: 'mbadge-failed' };
  const badgeLabel = { done: 'Done', running: 'Running', waiting: 'Waiting', pending: 'Pending', failed: 'Failed' };
  const needsVideo = [];

  projJobs.forEach(job => {
    const segIdx = job.params?.segmentIndex ?? 0;
    const item   = document.querySelector(`.acc-item[data-seg-idx="${segIdx}"]`);
    if (!item) return;

    const badge = item.querySelector('.mbadge');
    if (badge) {
      badge.className = `mbadge ${badgeClass[job.status] ?? ''}`;
      badge.textContent = badgeLabel[job.status] ?? job.status;
    }

    if (job.status === 'done' && !item.querySelector('video')) needsVideo.push(segIdx);
  });

  // Inject video elements for newly completed segments
  if (needsVideo.length > 0) {
    const projRes = await fetch(`/api/project/${id}`).catch(() => null);
    if (projRes?.ok) {
      const project = await projRes.json();
      const latestAsset = new Map();
      (project.generatedAssets ?? []).forEach(a => {
        const cur = latestAsset.get(a.segmentIndex);
        if (!cur || a.version > cur.version) latestAsset.set(a.segmentIndex, a);
      });
      needsVideo.forEach(segIdx => {
        const asset = latestAsset.get(segIdx);
        if (!asset) return;
        const item = document.querySelector(`.acc-item[data-seg-idx="${segIdx}"]`);
        if (!item) return;
        const body = item.querySelector('.acc-body');
        if (!body) return;
        body.innerHTML = `<video class="seg-video" data-src="/media/${id}/generated/${encodeURIComponent(asset.filename)}" muted playsinline controls preload="none"></video>`;
        if (item.classList.contains('open')) {
          const vid = body.querySelector('video');
          if (vid && !vid.src && vid.dataset.src) vid.src = vid.dataset.src;
        }
      });
    }
  }

  const stillActive = projJobs.some(j => ['pending','waiting','running'].includes(j.status));
  if (!stillActive) stopPolling();
}

function paintProjectDetail(id, project, jobs, exportFiles) {
  const latestExport = exportFiles[0] ?? null;

  const assets = project.generatedAssets ?? [];
  const latestAsset = new Map();
  assets.forEach(a => {
    const cur = latestAsset.get(a.segmentIndex);
    if (!cur || a.version > cur.version) latestAsset.set(a.segmentIndex, a);
  });

  const allSegIndices = [...new Set([
    ...jobs.map(j => j.params?.segmentIndex ?? 0),
    ...latestAsset.keys(),
    ...(project.segments?.map((_, i) => i) ?? []),
  ])].sort((a, b) => a - b);

  // ── Accordion segments ────────────────────────────────────────
  let accordionHtml = '';
  if (allSegIndices.length === 0) {
    accordionHtml = '<div class="seg-status-idle">No segments yet.</div>';
  } else {
    accordionHtml = allSegIndices.map(segIdx => {
      const asset  = latestAsset.get(segIdx);
      const job    = [...jobs].reverse().find(j => (j.params?.segmentIndex ?? 0) === segIdx);
      const status = job?.status ?? (asset ? 'done' : 'unknown');

      let bodyHtml = '';
      if (asset) {
        bodyHtml = `<video class="seg-video" data-src="/media/${id}/generated/${encodeURIComponent(asset.filename)}" muted playsinline controls preload="none"></video>`;
      } else if (status === 'running') {
        bodyHtml = `<div class="seg-status-pulse">Generating…</div>`;
      } else if (status === 'waiting') {
        bodyHtml = `<div class="seg-status-idle seg-status-waiting">Up next — ComfyUI busy</div>`;
      } else if (status === 'pending') {
        bodyHtml = `<div class="seg-status-idle">Pending in queue…</div>`;
      } else if (status === 'failed') {
        bodyHtml = `<div class="seg-status-idle" style="color:#b91c1c">Generation failed</div>`;
      } else {
        bodyHtml = `<div class="seg-status-idle">Not generated yet</div>`;
      }

      const badgeHtml = (status === 'done' || asset)
        ? `<span class="mbadge mbadge-done">Done</span>`
        : status === 'running'  ? `<span class="mbadge mbadge-running">Running</span>`
        : status === 'waiting'  ? `<span class="mbadge mbadge-waiting">Waiting</span>`
        : status === 'pending'  ? `<span class="mbadge mbadge-pending">Pending</span>`
        : status === 'failed'   ? `<span class="mbadge mbadge-failed">Failed</span>`
        : '';

      return `
        <div class="acc-item" data-seg-idx="${segIdx}">
          <button class="acc-header" type="button">
            <span class="acc-title">Segment ${segIdx + 1}</span>
            ${badgeHtml}
            <span class="acc-chevron">›</span>
          </button>
          <div class="acc-body">${bodyHtml}</div>
        </div>`;
    }).join('');
  }

  // ── Hero / render section ────────────────────────────────────
  const hasGenerated = project.segments?.some(s => s.generatedVideo) || latestAsset.size > 0;

  const heroHtml = latestExport ? `
    <div class="export-hero">
      <video class="export-video" src="/media/${id}/generated/${encodeURIComponent(latestExport)}"
        muted playsinline controls></video>
      <div class="export-label">Rendered output</div>
    </div>` : '';

  const renderHtml = `
    <div class="render-section" id="render-section">
      <label class="render-audio-label">
        <input type="checkbox" id="chk-render-audio">
        Include original audio
      </label>
      <button class="btn-render" id="btn-render" ${!hasGenerated ? 'disabled' : ''}>
        ${latestExport ? 'Render again' : 'Render video'}
      </button>
    </div>`;

  setView(`
    <div class="proj-detail">
      <div class="proj-detail-header">
        <a href="#projects" class="proj-back">← Projects</a>
        <span class="proj-detail-name">${esc(project.name || 'untitled')}</span>
      </div>
      ${heroHtml}
      ${renderHtml}
      ${allSegIndices.length > 0 ? '<div class="acc-section-label">Segments</div>' : ''}
      <div class="acc-list">${accordionHtml}</div>
    </div>
  `);

  // ── Wire accordion ────────────────────────────────────────────
  document.querySelectorAll('.acc-item').forEach(item => {
    item.querySelector('.acc-header').addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      // Close all, pause all videos
      document.querySelectorAll('.acc-item.open').forEach(other => {
        other.classList.remove('open');
        other.querySelector('video')?.pause();
      });
      if (!isOpen) {
        item.classList.add('open');
        const vid = item.querySelector('video');
        if (vid && !vid.src && vid.dataset.src) vid.src = vid.dataset.src;
      }
    });
  });

  // ── Wire render button ────────────────────────────────────────
  document.getElementById('btn-render')?.addEventListener('click', async () => {
    const includeAudio = document.getElementById('chk-render-audio')?.checked ?? false;
    const btnRender    = document.getElementById('btn-render');
    btnRender.disabled = true;
    btnRender.textContent = 'Rendering…';

    // Insert pulsing placeholder before render section, scroll to top
    const renderSection = document.getElementById('render-section');
    let placeholder = document.getElementById('export-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'export-hero';
      placeholder.id = 'export-placeholder';
      renderSection.parentElement.insertBefore(placeholder, renderSection);
    }
    placeholder.innerHTML = `<div class="export-placeholder"><div class="seg-status-pulse">Rendering video…</div></div>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      const res = await fetch(`/api/project/${id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeAudio }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Export failed');

      placeholder.innerHTML = `
        <video class="export-video" src="${data.path}" muted playsinline controls></video>
        <div class="export-label">Rendered output</div>`;

      btnRender.textContent = 'Render again';
      btnRender.disabled = false;
    } catch (e) {
      placeholder.remove();
      alert('Render failed: ' + e.message);
      btnRender.textContent = 'Render video';
      btnRender.disabled = false;
    }
  });
}
