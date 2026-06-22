let _sortAsc = localStorage.getItem('logsSortAsc') !== 'false';

const path  = location.pathname;
const match = path.match(/^\/logs\/(.+)$/);

if (match) {
  renderDetail(match[1]);
} else {
  renderList();
}

// ── Helpers ────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function badge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

function fmtElapsed(startedAt, completedAt) {
  if (!startedAt || !completedAt) return '—';
  const sec = Math.round((new Date(completedAt) - new Date(startedAt)) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m ${sec%60}s`;
}

// ── List view ──────────────────────────────────────────────────

function _applySortBtn(btn) {
  btn.classList.toggle('asc', _sortAsc);
  btn.title = _sortAsc ? 'Sort: oldest first' : 'Sort: newest first';
}

async function renderList() {
  document.title = 'Generation Logs · Motion Studio';
  document.getElementById('top-bar').innerHTML = `
    <a href="/" class="brand-link">← Studio</a>
    <span class="top-bar-title">Generation Logs</span>
    <button class="sort-btn" id="btn-sort-logs" title="Sort"></button>
  `;
  const sortBtn = document.getElementById('btn-sort-logs');
  _applySortBtn(sortBtn);
  sortBtn.addEventListener('click', () => {
    _sortAsc = !_sortAsc;
    localStorage.setItem('logsSortAsc', _sortAsc);
    _applySortBtn(sortBtn);
    _sortList();
  });

  const root = document.getElementById('root');
  root.innerHTML = '<div class="empty">Loading…</div>';

  let jobs;
  try {
    const res = await fetch('/api/jobs');
    ({ jobs } = await res.json());
  } catch {
    root.innerHTML = '<div class="empty">Failed to load logs.</div>';
    return;
  }

  if (!jobs.length) {
    root.innerHTML = '<div class="empty">No generation runs yet.</div>';
    return;
  }

  root.innerHTML = `<div class="job-list" id="job-list"></div>`;
  const list = document.getElementById('job-list');

  const _jobTs = job => new Date(job.queuedAt || job.createdAt || 0).getTime();
  function _sortList() {
    const cards = [...list.querySelectorAll('.job-card')];
    cards.sort((a, b) => {
      const ta = _jobTs(_jobMap.get(a.dataset.jobId));
      const tb = _jobTs(_jobMap.get(b.dataset.jobId));
      return _sortAsc ? ta - tb : tb - ta;
    });
    cards.forEach(c => list.appendChild(c));
  }

  const _jobMap = new Map();
  jobs.forEach(job => {
    _jobMap.set(job.id, job);
    const isQwen = job.params?.jobType === 'qwen-edit';
    const label  = isQwen
      ? `Frame ${job.params.frameIndex ?? '?'}${job.params.nsfw ? ' (NSFW)' : ''}`
      : `Segment ${(job.params?.segmentIndex ?? 0) + 1}`;
    const proj = job.params?.projectName ? ` · ${esc(job.params.projectName)}` : '';
    const err  = job.error
      ? `<div class="job-card-error">${esc(job.error)}</div>` : '';

    const card = document.createElement('a');
    card.className = 'job-card';
    card.href = `/logs/${job.id}`;
    card.innerHTML = `
      <div class="job-card-row">
        <span class="job-card-label">${esc(label)}<span class="job-card-project">${proj}</span></span>
        ${badge(job.status)}
      </div>
      ${err}
    `;
    list.appendChild(card);

    card.dataset.jobId = job.id;
  });

  _sortList();

  // One shared stream for all active jobs on this page
  const activeIds = new Set(
    jobs.filter(j => ['pending','waiting','running'].includes(j.status)).map(j => j.id)
  );
  if (activeIds.size > 0) {
    const es = new EventSource('/api/jobs/stream');
    es.onmessage = e => {
      const updated = JSON.parse(e.data);
      if (!activeIds.has(updated.id)) return;
      const card = list.querySelector(`[data-job-id="${updated.id}"]`);
      if (card) {
        const b = card.querySelector('.badge');
        if (b) { b.className = `badge badge-${updated.status}`; b.textContent = updated.status; }
      }
      if (!['pending','waiting','running'].includes(updated.status)) {
        activeIds.delete(updated.id);
        if (activeIds.size === 0) es.close();
      }
    };
    es.onerror = () => es.close();
  }
}

// ── Detail view ────────────────────────────────────────────────

async function renderDetail(jobId) {
  document.getElementById('top-bar').innerHTML = `
    <a href="/logs" class="back-btn">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
      Logs
    </a>
    <span class="top-bar-title" id="detail-title">…</span>
  `;

  const root = document.getElementById('root');
  root.innerHTML = '<div class="empty">Loading…</div>';

  let job;
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) throw new Error('not found');
    ({ job } = await res.json());
  } catch {
    root.innerHTML = '<div class="empty">Job not found.</div>';
    return;
  }

  paintDetail(job);

  if (['pending','waiting','running'].includes(job.status)) {
    const es = new EventSource('/api/jobs/stream');
    es.onmessage = e => {
      const updated = JSON.parse(e.data);
      if (updated.id !== jobId) return;
      paintDetail(updated);
      if (!['pending','waiting','running'].includes(updated.status)) es.close();
    };
    es.onerror = () => es.close();
  }
}

let _elapsedTimer = null;

function _fmtElapsed(startedAt, endAt) {
  const sec = Math.round((new Date(endAt) - new Date(startedAt)) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function _clearElapsedTimer() {
  if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
}

function paintDetail(job) {
  _clearElapsedTimer();

  const isQwen = job.params?.jobType === 'qwen-edit';
  const label  = isQwen
    ? `Frame ${job.params?.frameIndex ?? '?'}${job.params?.nsfw ? ' (NSFW)' : ''}`
    : `Segment ${(job.params?.segmentIndex ?? 0) + 1}`;
  document.title = `${label} — ${job.status} · Motion Studio`;
  const titleEl = document.getElementById('detail-title');
  if (titleEl) titleEl.textContent = `${label} — ${job.params?.projectName ?? ''}`;

  const durSec = (!isQwen && job.params?.frameCount && job.params?.genFps)
    ? (job.params.frameCount / job.params.genFps).toFixed(1) : null;
  const isLive = job.status === 'running' && job.startedAt && !job.completedAt;
  const elapsedSec = job.startedAt && job.completedAt
    ? Math.round((new Date(job.completedAt) - new Date(job.startedAt)) / 1000) : null;
  const elapsed = isLive ? _fmtElapsed(job.startedAt, new Date())
    : elapsedSec === null ? '—'
    : elapsedSec < 60 ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;

  const outputFile = job.result?.outputPath?.split('/').pop();
  const pid = job.params?.projectId;
  const outputLink = outputFile && pid
    ? `<a href="/media/${pid}/generated/${encodeURIComponent(outputFile)}" target="_blank" class="detail-link">▶ View output</a>`
    : '—';

  const refImg = job.params?.referenceImageFilename;
  const refTabContent = refImg && pid
    ? `<img class="detail-img" src="/media/${pid}/uploads/${encodeURIComponent(refImg)}" alt="Reference">`
    : `<div class="detail-media-empty">No reference image</div>`;

  let genTabContent;
  if (job.status === 'done' && outputFile && pid) {
    genTabContent = `<video src="/media/${pid}/generated/${encodeURIComponent(outputFile)}" controls playsinline style="width:100%;border-radius:var(--radius);display:block"></video>`;
  } else if (job.status === 'running') {
    genTabContent = `<div class="detail-media-pulse">Generating…</div>`;
  } else if (job.status === 'waiting') {
    genTabContent = `<div class="detail-media-empty detail-media-waiting">Waiting — ComfyUI busy</div>`;
  } else if (job.status === 'pending') {
    genTabContent = `<div class="detail-media-empty">Pending</div>`;
  } else {
    genTabContent = `<div class="detail-media-empty">—</div>`;
  }

  const rows = isQwen ? [
    ['Status',      badge(job.status)],
    ['Project',     esc(job.params?.projectName ?? '—')],
    ['Type',        `Qwen Edit${job.params?.nsfw ? ' (NSFW)' : ' (Safe)'}`],
    ['Frame #',     job.params?.frameIndex ?? '—'],
    ['Prompt',      esc(job.params?.prompt || '—')],
    ['Queued',      fmtTime(job.queuedAt || job.createdAt)],
    ['Started',     fmtTime(job.startedAt)],
    ['Elapsed',     isLive ? `<span id="job-elapsed">${elapsed}</span>` : elapsed],
    ...(job.error ? [['Error', `<span class="detail-error">${esc(job.error)}</span>`]] : []),
    ['Output',      outputLink],
  ] : [
    ['Status',      badge(job.status)],
    ['Project',     esc(job.params?.projectName ?? '—')],
    ['Segment #',   (job.params?.segmentIndex ?? 0) + 1],
    ['Frames',      job.params?.frameCount ?? '—'],
    ['Gen FPS',     job.params?.genFps ?? '—'],
    ['Duration',    durSec ? `${durSec}s` : '—'],
    ['Start frame', job.params?.startFrame ?? 0],
    ['Seed',        job.params?.seed ?? '—'],
    ['Queued',      fmtTime(job.queuedAt || job.createdAt)],
    ['Started',     fmtTime(job.startedAt)],
    ['Elapsed',     isLive ? `<span id="job-elapsed">${elapsed}</span>` : elapsed],
    ...(job.error ? [['Error', `<span class="detail-error">${esc(job.error)}</span>`]] : []),
    ['Output',      outputLink],
  ].map(([label, value]) =>
    `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`
  ).join('');

  document.getElementById('root').innerHTML = `
    <div class="detail-view">
      <div class="detail-section">${rows}</div>
      <div class="detail-media-wrap">
        <div class="media-tabs" id="detail-media-tabs">
          <button class="media-tab active" data-tab="ref">Ref Img</button>
          <button class="media-tab" data-tab="gen">Gen Video</button>
        </div>
        <div class="detail-img-wrap" id="detail-tab-ref">${refTabContent}</div>
        <div class="detail-img-wrap" id="detail-tab-gen" hidden>${genTabContent}</div>
      </div>
    </div>
  `;

  document.getElementById('detail-media-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.media-tab');
    if (!btn) return;
    document.querySelectorAll('#detail-media-tabs .media-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('detail-tab-ref').hidden = tab !== 'ref';
    document.getElementById('detail-tab-gen').hidden = tab !== 'gen';
  });

  if (isLive && job.startedAt) {
    _elapsedTimer = setInterval(() => {
      const el = document.getElementById('job-elapsed');
      if (el) el.textContent = _fmtElapsed(job.startedAt, new Date());
      else _clearElapsedTimer();
    }, 1000);
  }
}
