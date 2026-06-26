let _projectId = null;
let _videoFile  = null;
let _imageFile  = null;

// ── Advanced toggle ──────────────────────────────────────────────
document.getElementById('btn-advanced').addEventListener('click', () => {
  const panel = document.getElementById('advanced-panel');
  const btn   = document.getElementById('btn-advanced');
  const open  = panel.classList.toggle('open');
  btn.classList.toggle('open', open);
});

document.getElementById('btn-generate').addEventListener('click', onGenerate);
wireZone('input-video', 'zone-video', 'video-name', true);
wireZone('input-image', 'zone-image', 'image-name', false);

// ── Status helpers ───────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${type}`;
}

function updateGenerateBtn() {
  document.getElementById('btn-generate').disabled = !(_videoFile && _imageFile);
}

// ── Project creation ─────────────────────────────────────────────
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

// ── Upload zone ──────────────────────────────────────────────────
function setZoneBusy(zoneId, busy, label = '') {
  const zone  = document.getElementById(zoneId);
  if (!zone) return;
  const input  = zone.querySelector('input[type=file]');
  const iconEl = zone.querySelector('.upload-icon');
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
  setStatus('', '');

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

// ── Generate ─────────────────────────────────────────────────────
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
      body: JSON.stringify({
        mode,
        genFps: fps,
        genFramesPerSegment: frames,
        defaultPrompt: prompt || '',
        defaultSeed: isNaN(seed) ? -1 : seed,
      }),
    });

    await fetch(`/api/project/${id}/clips/${_videoFile.clipId}/segments`, { method: 'POST' });

    const genRes  = await fetch(`/api/project/${id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: _videoFile.clipId }),
    });
    const genData = await genRes.json();
    if (!genRes.ok) throw new Error(genData.error || 'Generation failed');

    window.location.href = `/projects/${id}`;
  } catch (e) {
    setStatus(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}
