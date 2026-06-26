// ── Constants ──────────────────────────────────────────────────
const PX_PER_FRAME = [4, 12, 30, 80];
const ROW_COUNT    = 4;
const TRAIL_PX     = 300; // empty drop zone after last segment
const RULER_H      = 22;  // px height of the ruler canvas

// Alternating segment band colours
const SEG_COLORS = [
  '#dbeafe', '#d1fae5', '#fef3c7', '#fce7f3',
  '#ede9fe', '#ffedd5', '#cffafe', '#dcfce7',
];

// ── State ──────────────────────────────────────────────────────
let project    = null;
let segLayout  = [];   // { ...seg, timelineStart }
let totalTLFrames = 0;
let _jobsBySegId = new Map(); // segId → job object

export function timelineSetJobs(jobs) {
  _jobsBySegId = new Map(jobs.map(j => [j.params?.segId, j]));
  draw();
}

let W = 0, H = 0;
let zoomLevel     = 0;
let scrollX       = 0;
let playheadFrame = null;
export let selectedSegId = null;

// thumb cache: `clipId:frameIndex` → HTMLImageElement | 'loading'
const thumbCache = new Map();
let thumbFetchTimer = null;

// ── Canvas setup ───────────────────────────────────────────────
const canvas      = document.getElementById('timeline-canvas');
const ctx         = canvas.getContext('2d');
const rulerCanvas = document.getElementById('timeline-ruler');
const rctx        = rulerCanvas.getContext('2d');

function rowH() { return H / ROW_COUNT; }
function ppf() {
  if (zoomLevel === 0 && segLayout.length > 0) {
    // 420px per full segment — timeline scrolls for longer projects
    const maxSegFrames = Math.max(...segLayout.map(s => s.frameCount));
    return 420 / Math.max(1, maxSegFrames);
  }
  return PX_PER_FRAME[zoomLevel];
}

function resize() {
  const parent = canvas.parentElement; // .timeline-right
  W = canvas.width  = rulerCanvas.width = parent.clientWidth;
  rulerCanvas.height = RULER_H;
  // Canvas height = parent height minus ruler
  H = canvas.height = Math.max(1, parent.clientHeight - RULER_H);
  draw();
}

const ro = new ResizeObserver(resize);
ro.observe(canvas.parentElement);

// ── Public API ─────────────────────────────────────────────────
export function timelineClearSelection() {
  selectedSegId = null;
  draw();
}

export function timelineRedraw() { draw(); }

export function timelinePatchSegment(segId, patch) {
  const entry = segLayout.find(s => s.id === segId);
  if (entry) Object.assign(entry, patch);
  draw();
}

export function timelineSetProject(p) {
  project = p;
  thumbCache.clear();

  // Build flat layout: each segment gets a timelineStart offset
  let offset = 0;
  segLayout = (p.segments || []).map(seg => {
    const entry = { ...seg, timelineStart: offset };
    offset += seg.frameCount;
    return entry;
  });
  totalTLFrames = offset;

  scrollX = 0;
  window._selectedTLFrame = null;
  draw();
  scheduleThumbs();
}

// ── Drawing ────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, W, H);

  if (!project || !segLayout.length) {
    drawEmpty();
    drawRuler();
    return;
  }

  drawRowBackgrounds();
  drawSegments();
  drawFrameThumbs();
  drawClipBoundaries();
  drawOverlays();
  drawRuler();
}

// ── Ruler ──────────────────────────────────────────────────────
function drawRuler() {
  const rW = rulerCanvas.width;
  rctx.clearRect(0, 0, rW, RULER_H);

  // Background
  rctx.fillStyle = '#f8fafc';
  rctx.fillRect(0, 0, rW, RULER_H);

  if (!project || totalTLFrames === 0) return;

  const p = ppf();

  // Tick interval: aim for a label every ~60px
  const framesPerLabel = Math.ceil(60 / Math.max(p, 0.01));
  const niceIntervals = [1, 2, 5, 10, 15, 24, 30, 60, 120, 300, 600, 1800];
  const tickInterval = niceIntervals.find(n => n >= framesPerLabel) || framesPerLabel;

  const startF = Math.max(0, Math.floor(scrollX / p / tickInterval) * tickInterval);

  for (let f = startF; f <= totalTLFrames + tickInterval; f += tickInterval) {
    const x = f * p - scrollX;
    if (x > rW + 10) break;
    if (x < -10) continue;

    // Minor tick
    rctx.strokeStyle = '#94a3b8'; rctx.lineWidth = 1;
    rctx.beginPath(); rctx.moveTo(x, RULER_H - 7); rctx.lineTo(x, RULER_H - 1); rctx.stroke();

    // Time label — timeline-relative (0-based), not source clip time
    const seg = segLayout.find(s => f >= s.timelineStart && f < s.timelineStart + s.frameCount);
    if (!seg) continue;
    const clip = project.sourceClips.find(c => c.id === seg.sourceClipId);
    const clipFps = clip?.fps || 30;
    const sec = f / clipFps;
    const label = sec < 60
      ? `${sec.toFixed(1)}s`
      : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

    rctx.fillStyle = '#475569';
    rctx.font = 'bold 9px system-ui, sans-serif';
    rctx.textAlign = 'left'; rctx.textBaseline = 'top';
    rctx.fillText(label, x + 2, 2);
  }

  // Selected frame cursor handle (indigo triangle pointing down)
  const sel = window._selectedTLFrame;
  if (sel != null) {
    const x = sel * p - scrollX;
    if (x >= -10 && x <= rW + 10) {
      rctx.fillStyle = '#6366f1';
      rctx.beginPath();
      rctx.moveTo(x - 5, 0);
      rctx.lineTo(x + 5, 0);
      rctx.lineTo(x, 9);
      rctx.closePath();
      rctx.fill();
      rctx.strokeStyle = 'rgba(99,102,241,0.35)'; rctx.lineWidth = 1;
      rctx.beginPath(); rctx.moveTo(x, 9); rctx.lineTo(x, RULER_H); rctx.stroke();
    }
  }

  // Playhead marker (red)
  if (playheadFrame != null) {
    const x = playheadFrame * p - scrollX;
    if (x >= 0 && x <= rW) {
      rctx.strokeStyle = '#ef4444'; rctx.lineWidth = 1.5;
      rctx.beginPath(); rctx.moveTo(x, 0); rctx.lineTo(x, RULER_H); rctx.stroke();
    }
  }
}

function drawEmpty() {
  const rh = rowH();
  const rowBgs = ['#f9fafb', '#ffffff', '#f3f4f6', '#ffffff'];
  for (let i = 0; i < ROW_COUNT; i++) {
    ctx.fillStyle = rowBgs[i];
    ctx.fillRect(0, i * rh, W, rh);
    if (i < ROW_COUNT - 1) {
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, (i + 1) * rh); ctx.lineTo(W, (i + 1) * rh); ctx.stroke();
    }
  }
  if (dragOverTrail) {
    ctx.fillStyle = 'rgba(99,102,241,0.10)';
    ctx.fillRect(16, 8, W - 32, H - 16);
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(16, 8, W - 32, H - 16);
    ctx.setLineDash([]);
    ctx.fillStyle = '#6366f1'; ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('+ drop to add segments', W / 2, H / 2);
  } else {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Drag a video from the assets panel to add segments', W / 2, 2.5 * rh);
  }
}

function drawRowBackgrounds() {
  const rh = rowH();
  const colors = ['#f9fafb', '#ffffff', '#f3f4f6', '#ffffff'];
  for (let i = 0; i < ROW_COUNT; i++) {
    ctx.fillStyle = colors[i];
    ctx.fillRect(0, i * rh, W, rh);
  }
  // Horizontal row dividers
  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
  for (let i = 1; i < ROW_COUNT; i++) {
    ctx.beginPath(); ctx.moveTo(0, i * rh); ctx.lineTo(W, i * rh); ctx.stroke();
  }
}

function drawSegments() {
  const rh   = rowH();
  const segY = rh * 2;  // row 2

  segLayout.forEach((seg, idx) => {
    const x = seg.timelineStart * ppf() - scrollX;
    const w = seg.frameCount * ppf();

    if (x + w < 0 || x > W) return; // off-screen

    // Coloured band
    ctx.fillStyle = SEG_COLORS[idx % SEG_COLORS.length];
    ctx.fillRect(x, segY + 1, w, rh - 2);

    // Left border
    ctx.fillStyle = adjustAlpha(SEG_COLORS[idx % SEG_COLORS.length], 0.6);
    ctx.fillRect(x, segY + 1, 2, rh - 2);

    // Checkbox (selected state)
    const cbX = Math.max(x, 0) + 4;
    const cbY = segY + (rh - 10) / 2;
    ctx.lineWidth = 1.5;
    if (seg.selected !== false) {
      ctx.fillStyle = '#3b82f6';
      ctx.strokeStyle = '#3b82f6';
      ctx.beginPath(); ctx.roundRect(cbX, cbY, 10, 10, 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cbX + 2, cbY + 5); ctx.lineTo(cbX + 4, cbY + 7); ctx.lineTo(cbX + 8, cbY + 3);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#f9fafb';
      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(cbX, cbY, 10, 10, 2); ctx.fill(); ctx.stroke();
    }

    // Label (only if there's enough room)
    if (w > 40) {
      const clip        = project.sourceClips?.find(c => c.id === seg.sourceClipId);
      const effectiveFps = project.useSourceFps && clip?.fps ? clip.fps : (project.genFps ?? 24);
      const genFrames   = clip?.fps ? Math.round(seg.frameCount / clip.fps * effectiveFps) : (project.genFramesPerSegment ?? 81);
      const fpsLabel    = project.useSourceFps && clip?.fps ? `${clip.fps % 1 === 0 ? clip.fps : clip.fps.toFixed(2)} fps` : `${effectiveFps}fps`;
      ctx.fillStyle = '#374151';
      ctx.font = `11px system-ui, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.save();
      ctx.rect(Math.max(x, 0), segY, Math.min(w, W - Math.max(x, 0)), rh);
      ctx.clip();
      ctx.fillText(`Segment ${idx + 1} . ${fpsLabel} . ${genFrames} Frames`, Math.max(x, 0) + 20, segY + rh / 2);
      ctx.restore();
    }

    // Selected segment highlight
    if (seg.id === selectedSegId) {
      ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, segY + 1, w - 2, rh - 2);
    }

    // Dimmed overlay for unselected segments
    if (seg.selected === false) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x, segY + 1, w, rh - 2);
    }

    // Right boundary tick
    const rx = x + w;
    if (rx >= 0 && rx <= W) {
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(rx, segY); ctx.lineTo(rx, segY + rh); ctx.stroke();
    }

    // Ref row (row 1)
    const refY    = rh;
    const hasRef  = !!seg.referenceImage;
    const isHover = seg.id === dragOverSegId;

    if (isHover) {
      ctx.fillStyle = '#dbeafe';
      ctx.fillRect(x + 1, refY + 2, w - 2, rh - 4);
    }
    ctx.strokeStyle = isHover ? '#3b82f6' : hasRef ? '#86efac' : '#d1d5db';
    ctx.lineWidth = isHover ? 2 : 1;
    ctx.setLineDash(hasRef || isHover ? [] : [4, 3]);
    ctx.strokeRect(x + 1, refY + 2, w - 2, rh - 4);
    ctx.setLineDash([]);

    if (w > 20) {
      ctx.fillStyle = hasRef ? '#15803d' : isHover ? '#1d4ed8' : '#d1d5db';
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = hasRef
        ? seg.referenceImage.replace(/\.[^.]+$/, '').slice(0, Math.floor(w / 7))
        : '+';
      ctx.save();
      ctx.rect(Math.max(x, 0), refY, Math.min(w, W - Math.max(x, 0)), rh);
      ctx.clip();
      ctx.fillText(label, Math.max(x + w / 2, 10), refY + rh / 2);
      ctx.restore();
    }

    // Gen row (row 0)
    const genY      = 0;
    const hasGen    = !!seg.generatedVideo;
    const isGenHide = hasGen && (window._hiddenGenSegIds?.has(seg.id) ?? false);
    const activeJob = !hasGen ? _jobsBySegId.get(seg.id) : null;
    const jobStatus = activeJob?.status;

    if (hasGen) {
      ctx.globalAlpha = isGenHide ? 0.4 : 1;
      ctx.fillStyle = '#bbf7d0';
      ctx.fillRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.strokeStyle = isGenHide ? '#9ca3af' : '#16a34a';
      ctx.lineWidth = isGenHide ? 1 : 1.5;
      ctx.setLineDash(isGenHide ? [3, 2] : []);
      ctx.strokeRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Eye icon (right side of segment, 20px wide hit zone)
      const eyeAreaW = 20;
      const eyeRight = Math.min(x + w - 1, W - 1);
      const eyeLeft  = eyeRight - eyeAreaW;
      if (eyeRight > Math.max(x, 0) && w > 30) {
        const eyeCx = eyeLeft + eyeAreaW / 2;
        const eyeCy = genY + rh / 2;
        ctx.save();
        ctx.rect(Math.max(x, 0), genY, Math.min(w, W - Math.max(x, 0)), rh);
        ctx.clip();
        const eyeColor = isGenHide ? '#9ca3af' : '#15803d';
        ctx.strokeStyle = eyeColor; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(eyeCx, eyeCy, 5.5, 3.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = eyeColor;
        ctx.beginPath();
        ctx.arc(eyeCx, eyeCy, 2, 0, Math.PI * 2);
        ctx.fill();
        if (isGenHide) {
          ctx.strokeStyle = eyeColor; ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(eyeCx - 6, eyeCy + 4);
          ctx.lineTo(eyeCx + 6, eyeCy - 4);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (w > 40) {
        ctx.fillStyle = isGenHide ? '#9ca3af' : '#15803d';
        ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.save();
        ctx.rect(Math.max(x, 0), genY, Math.min(w - eyeAreaW - 2, W - Math.max(x, 0)), rh);
        ctx.clip();
        ctx.fillText('Generated', Math.max(x, 0) + 4, genY + rh / 2);
        ctx.restore();
      }
    } else if (jobStatus === 'running') {
      const label = 'Running';
      ctx.fillStyle = '#dbeafe';
      ctx.fillRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, genY + 2, w - 2, rh - 4);
      if (w > 20) {
        ctx.fillStyle = '#1d4ed8';
        ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.save();
        ctx.rect(Math.max(x, 0), genY, Math.min(w, W - Math.max(x, 0)), rh);
        ctx.clip();
        ctx.fillText(label, Math.max(x + w / 2, 10), genY + rh / 2);
        ctx.restore();
      }
    } else if (jobStatus === 'waiting') {
      ctx.fillStyle = '#fffbeb';
      ctx.fillRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.setLineDash([]);
      if (w > 20) {
        ctx.fillStyle = '#b45309';
        ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.save();
        ctx.rect(Math.max(x, 0), genY, Math.min(w, W - Math.max(x, 0)), rh);
        ctx.clip();
        ctx.fillText('Waiting', Math.max(x + w / 2, 10), genY + rh / 2);
        ctx.restore();
      }
    } else if (jobStatus === 'pending') {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.setLineDash([]);
      if (w > 20) {
        ctx.fillStyle = '#64748b';
        ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.save();
        ctx.rect(Math.max(x, 0), genY, Math.min(w, W - Math.max(x, 0)), rh);
        ctx.clip();
        ctx.fillText('Pending', Math.max(x + w / 2, 10), genY + rh / 2);
        ctx.restore();
      }
    } else {
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 1, genY + 2, w - 2, rh - 4);
      ctx.setLineDash([]);
    }
  });
}

function drawFrameThumbs() {
  const rh     = rowH();
  const frameY = rh * 3;  // row 3
  const p      = ppf();

  if (p < 20) {
    // Low zoom: one representative thumbnail per segment
    segLayout.forEach(seg => {
      const x = seg.timelineStart * ppf() - scrollX;
      const w = seg.frameCount * ppf();
      if (x + w < 0 || x > W) return;

      const midClipFrame = seg.startFrame + Math.floor(seg.frameCount / 2);
      const key = `${seg.sourceClipId}:${midClipFrame}`;
      const img = thumbCache.get(key);

      if (img instanceof HTMLImageElement) {
        ctx.drawImage(img, x, frameY, w, rh);
      } else {
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(x, frameY, w, rh);
        if (img === 'loading') {
          ctx.fillStyle = '#9ca3af';
          ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('…', x + w / 2, frameY + rh / 2);
        }
      }
    });
    return;
  }

  // High zoom: individual frame thumbnails
  const startTL = Math.max(0, Math.floor(scrollX / p));
  const endTL   = Math.min(totalTLFrames - 1, Math.ceil((scrollX + W) / p));

  for (let tlFrame = startTL; tlFrame <= endTL; tlFrame++) {
    const seg = segLayout.find(
      s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount
    );
    if (!seg) continue;

    const clipFrame = seg.startFrame + (tlFrame - seg.timelineStart);
    const key       = `${seg.sourceClipId}:${clipFrame}`;
    const img       = thumbCache.get(key);
    const fx        = tlFrame * p - scrollX;

    if (img instanceof HTMLImageElement) {
      ctx.drawImage(img, fx, frameY, p, rh);
    } else {
      ctx.fillStyle = img === 'loading' ? '#f3f4f6' : '#e5e7eb';
      ctx.fillRect(fx, frameY, p - 1, rh);
    }

    // Frame tick at higher zoom
    if (p >= 30) {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(fx + p, frameY); ctx.lineTo(fx + p, frameY + rh); ctx.stroke();
    }
  }
}

function drawClipBoundaries() {
  if (!project.sourceClips || project.sourceClips.length < 2) return;

  const rh = rowH();
  // A boundary is wherever sourceClipId changes between consecutive segments
  for (let i = 1; i < segLayout.length; i++) {
    if (segLayout[i].sourceClipId !== segLayout[i - 1].sourceClipId) {
      const x = segLayout[i].timelineStart * ppf() - scrollX;
      if (x < 0 || x > W) continue;
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, rh * 3); ctx.lineTo(x, H); ctx.stroke();

      // Label
      ctx.fillStyle = '#6366f1';
      ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('clip', x + 3, rh * 3 + 2);
    }
  }
}

function drawOverlays() {
  const p = ppf();

  // Selected frame highlight
  const sel = window._selectedTLFrame;
  if (sel != null) {
    const x = sel * p - scrollX;
    ctx.fillStyle = 'rgba(99,102,241,0.2)';
    ctx.fillRect(x, 0, p, H);
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0);     ctx.lineTo(x, H);     ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + p, 0); ctx.lineTo(x + p, H); ctx.stroke();
  }

  // Playhead (line only — triangle handle is drawn on the ruler)
  if (playheadFrame != null) {
    const px = playheadFrame * p - scrollX;
    if (px >= 0 && px <= W) {
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
  }

  // Trail drop hint
  if (segLayout.length > 0) {
    const last   = segLayout[segLayout.length - 1];
    const trailX = Math.max(0, (last.timelineStart + last.frameCount) * p - scrollX);
    if (trailX < W - 40) {
      const boxW = Math.min(140, W - trailX - 12);
      const hintCx = trailX + 6 + boxW / 2;
      if (dragOverTrail) {
        ctx.fillStyle = 'rgba(99,102,241,0.12)';
        ctx.fillRect(trailX + 6, 4, boxW, H - 8);
        ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(trailX + 6, 4, boxW, H - 8);
        ctx.fillStyle = '#6366f1'; ctx.font = 'bold 10px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+ append clip', hintCx, H / 2);
      } else {
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(trailX + 6, 4, boxW, H - 8);
        ctx.setLineDash([]);
        ctx.fillStyle = '#d1d5db'; ctx.font = '10px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('drag video here', hintCx, H / 2);
      }
    }
  }
}

// ── Playhead from player ───────────────────────────────────────
document.addEventListener('player:timeupdate', e => {
  if (!project || !segLayout.length) return;
  const { currentTime, clipId, fps, isPlaying } = e.detail;

  const frameIdx = Math.floor(currentTime * fps);
  const seg = segLayout.find(
    s => s.sourceClipId === clipId &&
         frameIdx >= s.startFrame &&
         frameIdx < s.startFrame + s.frameCount
  );
  if (!seg) return;

  const tlFrame = seg.timelineStart + (frameIdx - seg.startFrame);
  playheadFrame          = tlFrame;
  window._selectedTLFrame = tlFrame;

  // Auto-scroll only while playing — never clobber manual scroll position
  if (isPlaying) {
    const px = tlFrame * ppf() - scrollX;
    if (px > W * 0.75) {
      const maxScroll = Math.max(0, totalTLFrames * ppf() + TRAIL_PX - W);
      scrollX = Math.min(maxScroll, scrollX + (px - W * 0.6));
      scheduleThumbs();
    } else if (px < W * 0.1 && scrollX > 0) {
      scrollX = Math.max(0, scrollX - (W * 0.2 - px));
      scheduleThumbs();
    }
  }

  draw();
});

// ── Pointer interactions (pan + click) ────────────────────────
let panStartX  = 0;
let panStartSX = 0;
let panMoved   = false;
let isPanning  = false;

canvas.addEventListener('mousemove', e => {
  if (isPanning) return;
  if (!project || !segLayout.length) { canvas.style.cursor = 'crosshair'; return; }
  if (isTrailArea(e.offsetX)) { canvas.style.cursor = 'default'; return; }
  const rh     = rowH();
  const rowIdx = Math.floor(e.offsetY / rh);
  const tlFrame = Math.floor((e.offsetX + scrollX) / ppf());
  const seg = segLayout.find(s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount);
  if ((rowIdx === 0 && (seg?.generatedVideo || _jobsBySegId.has(seg?.id))) || (rowIdx === 2 && seg)) {
    canvas.style.cursor = 'pointer';
  } else {
    canvas.style.cursor = 'crosshair';
  }
});

canvas.addEventListener('mouseleave', () => { if (!isPanning) canvas.style.cursor = 'crosshair'; });

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  isPanning  = true;
  panStartX  = e.clientX;
  panStartSX = scrollX;
  panMoved   = false;
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', e => {
  if (!isPanning) return;
  const dx = e.clientX - panStartX;
  if (Math.abs(dx) > 3) panMoved = true;
  if (!panMoved) return;
  const maxScroll = Math.max(0, totalTLFrames * ppf() + TRAIL_PX - W);
  scrollX = Math.max(0, Math.min(maxScroll, panStartSX - dx));
  draw();
  scheduleThumbs();
});

window.addEventListener('mouseup', () => {
  isPanning = false;
  canvas.style.cursor = 'crosshair';
});

canvas.addEventListener('click', e => {
  if (panMoved) return;
  if (!project || !segLayout.length) return;
  hideContextMenu();

  const rh     = rowH();
  const rowIdx = Math.floor(e.offsetY / rh);
  const tlFrame = Math.floor((e.offsetX + scrollX) / ppf());
  if (tlFrame < 0 || tlFrame >= totalTLFrames) return;

  const seg = segLayout.find(
    s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount
  );
  if (!seg) return;

  if (rowIdx === 0) {
    if (seg.generatedVideo) {
      // Check if click is on the eye icon area (right 20px of visible segment)
      const segW     = seg.frameCount * ppf();
      const segEndX  = Math.min(seg.timelineStart * ppf() - scrollX + segW, W);
      const eyeHitX  = segEndX - 20;
      if (e.offsetX >= eyeHitX && segW > 30) {
        document.dispatchEvent(new CustomEvent('segment:togglegen', { detail: { segId: seg.id } }));
      } else {
        document.dispatchEvent(new CustomEvent('segment:showjob', { detail: { segId: seg.id } }));
      }
    } else if (_jobsBySegId.has(seg.id)) {
      // Pending/running/waiting job — clicking shows the job
      document.dispatchEvent(new CustomEvent('segment:showjob', { detail: { segId: seg.id } }));
    }
    return;
  }

  if (rowIdx === 2) {
    // Segs row — check if click is on the checkbox hit area
    const segX = seg.timelineStart * ppf() - scrollX;
    const cbHitX = Math.max(segX, 0) + 4;
    if (e.offsetX >= cbHitX && e.offsetX <= cbHitX + 18) {
      document.dispatchEvent(new CustomEvent('segment:toggleselect', { detail: { segId: seg.id } }));
      return;
    }
    // Otherwise select / deselect segment
    selectedSegId = selectedSegId === seg.id ? null : seg.id;
    draw();
    document.dispatchEvent(new CustomEvent('segment:select', { detail: { segId: selectedSegId } }));
    return;
  }

  // Frames / other rows — select frame
  const clipFrame = seg.startFrame + (tlFrame - seg.timelineStart);
  window._selectedTLFrame = tlFrame;
  draw();
  document.dispatchEvent(new CustomEvent('frame:select', {
    detail: { clipId: seg.sourceClipId, frameIndex: clipFrame }
  }));
});

// ── Right-click context menu ───────────────────────────────────
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!project || !segLayout.length) return;

  const tlFrame = Math.floor((e.offsetX + scrollX) / ppf());
  const seg = segLayout.find(
    s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount
  );
  if (!seg) return;

  selectedSegId = seg.id;
  document.dispatchEvent(new CustomEvent('segment:select', { detail: { segId: selectedSegId } }));
  draw();

  const menu = document.getElementById('seg-context-menu');
  menu.style.left = `${e.clientX}px`;
  menu.style.top  = `${e.clientY}px`;
  menu.hidden = false;
});

function hideContextMenu() {
  document.getElementById('seg-context-menu').hidden = true;
}

document.addEventListener('click',      hideContextMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });

// Delete key removes selected segment
document.addEventListener('keydown', e => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSegId) {
    if (['INPUT','TEXTAREA','SL-INPUT','SL-TEXTAREA'].includes(document.activeElement?.tagName)) return;
    document.dispatchEvent(new CustomEvent('segment:delete', { detail: { segId: selectedSegId } }));
  }
});

// ── Refs row / trail drag-drop ─────────────────────────────────
let dragOverSegId  = null;
let dragOverTrail  = false;

function segAtX(offsetX) {
  const tlFrame = Math.floor((offsetX + scrollX) / ppf());
  return segLayout.find(s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount) || null;
}

function isRefsRow(offsetY) {
  return offsetY >= rowH() && offsetY < rowH() * 2;
}

function isTrailArea(offsetX) {
  if (!segLayout.length) return true;
  const last = segLayout[segLayout.length - 1];
  return offsetX + scrollX >= (last.timelineStart + last.frameCount) * ppf();
}

// getData() is blocked during dragover by browsers — only .types is readable.
// We store the asset type as a MIME-style key so we can filter without getData().
const IMAGE_DRAG_TYPE = 'application/x-ms-asset-image'; // present only for image assets
const VIDEO_DRAG_TYPE = 'application/x-ms-asset-video'; // present only for video assets

canvas.addEventListener('dragover', e => {
  const isVideo = e.dataTransfer.types.includes(VIDEO_DRAG_TYPE);
  const isImage = !isVideo && (e.dataTransfer.types.includes(IMAGE_DRAG_TYPE) ||
                               e.dataTransfer.types.includes('text/plain'));

  if (isVideo && isTrailArea(e.offsetX)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOverTrail) { dragOverTrail = true; draw(); }
    return;
  }

  if (!isRefsRow(e.offsetY) || !isImage) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const seg = segAtX(e.offsetX);
  if (seg?.id !== dragOverSegId) {
    dragOverSegId = seg?.id || null;
    draw();
  }
});

canvas.addEventListener('dragleave', e => {
  let changed = false;
  if (dragOverSegId)  { dragOverSegId = null; changed = true; }
  if (dragOverTrail)  { dragOverTrail = false; changed = true; }
  if (changed) draw();
});

canvas.addEventListener('drop', e => {
  e.preventDefault();
  const wasTrail = dragOverTrail;
  dragOverSegId = null;
  dragOverTrail = false;
  draw();

  const filename = e.dataTransfer.getData('text/plain');
  if (!filename) return;

  const isVideo = /\.(mp4|mov|avi|webm|mkv)$/i.test(filename);

  // Video dropped on trail → append segments for that clip
  if (isVideo && wasTrail) {
    const clipId = e.dataTransfer.getData(VIDEO_DRAG_TYPE) || null;
    if (clipId) {
      document.dispatchEvent(new CustomEvent('clip:appendsegments', { detail: { clipId } }));
    }
    return;
  }

  // Image dropped on a Refs-row segment
  if (!isVideo && isRefsRow(e.offsetY)) {
    const seg = segAtX(e.offsetX);
    if (!seg) return;
    document.dispatchEvent(new CustomEvent('segment:setref', { detail: { segId: seg.id, filename } }));
  }
});

// ── Thumbnail lazy loading ─────────────────────────────────────
function scheduleThumbs() {
  clearTimeout(thumbFetchTimer);
  thumbFetchTimer = setTimeout(fetchVisibleThumbs, 80);
}

async function fetchVisibleThumbs() {
  if (!project || !segLayout.length) return;

  const p       = ppf();
  const showIndividual = p >= 20;

  const toFetch = new Map(); // clipId → { min, max }

  if (showIndividual) {
    const startTL = Math.max(0, Math.floor(scrollX / p));
    const endTL   = Math.min(totalTLFrames - 1, Math.ceil((scrollX + W) / p));

    for (let tlFrame = startTL; tlFrame <= endTL; tlFrame++) {
      const seg = segLayout.find(
        s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount
      );
      if (!seg) continue;
      const clipFrame = seg.startFrame + (tlFrame - seg.timelineStart);
      const key = `${seg.sourceClipId}:${clipFrame}`;
      if (!thumbCache.has(key)) {
        const r = toFetch.get(seg.sourceClipId) || { min: clipFrame, max: clipFrame, clipId: seg.sourceClipId };
        r.min = Math.min(r.min, clipFrame);
        r.max = Math.max(r.max, clipFrame);
        toFetch.set(seg.sourceClipId, r);
      }
    }
  } else {
    // Segment midpoints only
    segLayout.forEach(seg => {
      const x = seg.timelineStart * p - scrollX;
      const w = seg.frameCount * p;
      if (x + w < 0 || x > W) return;

      const mid = seg.startFrame + Math.floor(seg.frameCount / 2);
      const key = `${seg.sourceClipId}:${mid}`;
      if (!thumbCache.has(key)) {
        toFetch.set(seg.sourceClipId, { min: mid, max: mid, clipId: seg.sourceClipId });
      }
    });
  }

  for (const { clipId, min, max } of toFetch.values()) {
    fetchThumbRange(clipId, min, max);
  }
}

async function fetchThumbRange(clipId, startFrame, endFrame) {
  // Mark range as loading
  for (let f = startFrame; f <= endFrame; f++) {
    const k = `${clipId}:${f}`;
    if (!thumbCache.has(k)) thumbCache.set(k, 'loading');
  }

  try {
    const res  = await fetch(
      `/api/project/${project.id}/thumbnails?clipId=${clipId}&start=${startFrame}&end=${endFrame}`
    );
    const { frames } = await res.json();

    for (const { frame, url } of frames) {
      const img = new Image();
      img.onload = () => {
        thumbCache.set(`${clipId}:${frame}`, img);
        requestAnimationFrame(draw);
      };
      img.onerror = () => thumbCache.delete(`${clipId}:${frame}`);
      img.src = url;
    }
  } catch {
    // Clear loading markers so they retry on next scroll
    for (let f = startFrame; f <= endFrame; f++) {
      if (thumbCache.get(`${clipId}:${f}`) === 'loading')
        thumbCache.delete(`${clipId}:${f}`);
    }
  }
}

// ── Public helper for split ────────────────────────────────────
export function getFrameInfo(tlFrame) {
  const seg = segLayout.find(s => tlFrame >= s.timelineStart && tlFrame < s.timelineStart + s.frameCount);
  if (!seg) return null;
  return {
    segId:      seg.id,
    clipId:     seg.sourceClipId,
    clipFrame:  seg.startFrame + (tlFrame - seg.timelineStart),
  };
}

// ── Ruler drag (sets cursor position) ─────────────────────────
let isCursorDrag = false;

function cursorFrameFromRulerX(offsetX) {
  return Math.max(0, Math.min(totalTLFrames - 1, Math.floor((offsetX + scrollX) / ppf())));
}

function applyCursorDrag(offsetX) {
  if (!project || !segLayout.length) return;
  const tlFrame = cursorFrameFromRulerX(offsetX);
  window._selectedTLFrame = tlFrame;
  draw(); // also calls drawRuler
}

rulerCanvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  isCursorDrag = true;
  applyCursorDrag(e.offsetX);
  e.preventDefault();
});

window.addEventListener('mousemove', e => {
  if (!isCursorDrag) return;
  const rect = rulerCanvas.getBoundingClientRect();
  applyCursorDrag(e.clientX - rect.left);
});

window.addEventListener('mouseup', e => {
  if (!isCursorDrag) return;
  isCursorDrag = false;
  // Fire frame:select so the right panel updates
  const tlFrame = window._selectedTLFrame;
  if (tlFrame == null) return;
  const info = getFrameInfo(tlFrame);
  if (!info) return;
  document.dispatchEvent(new CustomEvent('frame:select', {
    detail: { clipId: info.clipId, frameIndex: info.clipFrame },
  }));
});

// ── Zoom ───────────────────────────────────────────────────────
const zoomSelect = document.getElementById('zoom-select');

function setZoom(val) {
  zoomLevel = Math.max(0, Math.min(3, val));
  // Snap select to nearest option value
  const opts = [...zoomSelect.options].map(o => Number(o.value));
  zoomSelect.value = opts.reduce((a, b) => Math.abs(b - zoomLevel) < Math.abs(a - zoomLevel) ? b : a);
  thumbCache.clear();
  draw();
  scheduleThumbs();
}

zoomSelect.addEventListener('change', () => setZoom(Number(zoomSelect.value)));

// Ctrl/Meta+wheel → toggle between segment/frame view
const tlSection = document.querySelector('.timeline-section');
tlSection.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    setZoom(zoomLevel <= 1 ? 2 : 0);
    return;
  }
  // Two-finger trackpad sends deltaX; mouse wheel sends deltaY only
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const maxScroll = Math.max(0, totalTLFrames * ppf() + TRAIL_PX - W);
  scrollX = Math.max(0, Math.min(maxScroll, scrollX + delta));
  draw();
  scheduleThumbs();
}, { passive: false });

// ── Helpers ────────────────────────────────────────────────────
function adjustAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Initial render
resize();
