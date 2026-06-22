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

  // Advanced toggle
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

    // Navigate to the project detail view
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

    const items = projects.map(p => {
      const sub = p.segmentCount
        ? `${p.segmentCount} segment${p.segmentCount !== 1 ? 's' : ''}`
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
  const [projRes, jobsRes] = await Promise.all([
    fetch(`/api/project/${id}`),
    fetch('/api/jobs'),
  ]);
  if (!projRes.ok) { setView('<div class="mobile-empty">Project not found.</div>'); return; }

  const project  = await projRes.json();
  const { jobs } = await jobsRes.json();
  const projJobs = jobs.filter(j => j.params?.projectId === id);

  paintProjectDetail(id, project, projJobs);

  const hasActive = projJobs.some(j => ['pending','waiting','running'].includes(j.status));
  if (hasActive && !_detailTimer) {
    _detailTimer = setInterval(async () => {
      if (location.hash !== `#project/${id}`) { stopPolling(); return; }
      await fetchAndPaintDetail(id);
    }, 3000);
  }
}

function paintProjectDetail(id, project, jobs) {
  const assets = project.generatedAssets ?? [];

  // Latest asset per segmentIndex
  const latestAsset = new Map();
  assets.forEach(a => {
    const cur = latestAsset.get(a.segmentIndex);
    if (!cur || a.version > cur.version) latestAsset.set(a.segmentIndex, a);
  });

  const allSegIndices = [...new Set([
    ...jobs.map(j => j.params?.segmentIndex ?? 0),
    ...latestAsset.keys(),
  ])].sort((a, b) => a - b);

  const cards = allSegIndices.map(segIdx => {
    const asset = latestAsset.get(segIdx);
    // Most recent job for this segment
    const job   = [...jobs].reverse().find(j => (j.params?.segmentIndex ?? 0) === segIdx);
    const status = job?.status ?? (asset ? 'done' : 'unknown');

    let mediaSrc = '';
    if (asset) {
      mediaSrc = `<video class="seg-video" src="/media/${id}/generated/${encodeURIComponent(asset.filename)}" autoplay muted loop playsinline controls></video>`;
    } else if (status === 'running') {
      mediaSrc = `<div class="seg-status-pulse">Generating…</div>`;
    } else if (status === 'waiting') {
      mediaSrc = `<div class="seg-status-idle seg-status-waiting">Up next — ComfyUI busy</div>`;
    } else if (status === 'pending') {
      mediaSrc = `<div class="seg-status-idle">Pending in queue…</div>`;
    } else if (status === 'failed') {
      mediaSrc = `<div class="seg-status-idle" style="color:#b91c1c">Generation failed</div>`;
    }

    const badgeHtml = status === 'done' || asset
      ? `<span class="mbadge mbadge-done">Done</span>`
      : status === 'running'
      ? `<span class="mbadge mbadge-running">Running</span>`
      : status === 'waiting'
      ? `<span class="mbadge mbadge-waiting">Waiting</span>`
      : status === 'pending'
      ? `<span class="mbadge mbadge-pending">Pending</span>`
      : status === 'failed'
      ? `<span class="mbadge mbadge-failed">Failed</span>`
      : '';

    return `
      <div class="seg-card">
        <div class="seg-card-header">
          <span>Segment ${segIdx + 1}</span>
          ${badgeHtml}
        </div>
        ${mediaSrc}
      </div>`;
  }).join('');

  const noCards = allSegIndices.length === 0
    ? '<div class="seg-status-idle">No segments yet.</div>'
    : '';

  setView(`
    <div class="proj-detail">
      <div class="proj-detail-header">
        <a href="#projects" class="proj-back">← Projects</a>
        <span class="proj-detail-name">${esc(project.name || 'untitled')}</span>
      </div>
      ${cards}${noCards}
    </div>
  `);
}
