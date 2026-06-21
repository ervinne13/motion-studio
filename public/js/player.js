const video       = document.getElementById('preview-video');
const overlayVideo= document.getElementById('overlay-video');
const placeholder = document.getElementById('preview-placeholder');
const timecodeEl  = document.getElementById('timecode');
const btnPlay     = document.getElementById('btn-play-preview');
const btnMute     = document.getElementById('btn-mute');
const iconSound   = document.getElementById('icon-sound');
const iconMuted   = document.getElementById('icon-muted');

let currentClip = null;
let currentFps  = 24;
let rafHandle   = null;

// Generated segment windows: [{ startSec, endSec, url, segId }] sorted by startSec
let genSegments   = [];
const overlayDone = new Set(); // startSec values already triggered this play
const hiddenSegIds = new Set(); // segIds toggled off via eye button in Gen row

function visibleSegs() {
  return genSegments.filter(s => !hiddenSegIds.has(s.segId));
}

// ── Public API ─────────────────────────────────────────────────
export function playerLoadClip(clip, projectId) {
  if (currentClip?.id === clip.id) return;
  currentClip = clip;
  currentFps  = clip.fps;

  const src = `/media/${projectId}/uploads/${clip.filename}`;
  if (video.src !== new URL(src, location.href).href) {
    video.src = src;
    video.load();
  }

  placeholder.hidden = true;
  video.hidden       = false;
  btnPlay.disabled   = false;
  btnMute.disabled   = false;
  startTimecodeLoop();
}

export function playerSeek(timeSec) {
  if (!video.src) return;
  video.currentTime = timeSec;
  updateTimecode();
  dispatchTimeUpdate();
}

export function playerSetGenSegments(segments, projectId, clipFps) {
  genSegments = segments
    .filter(s => s.generatedVideo)
    .map(s => ({
      startSec: s.startFrame / clipFps,
      endSec:   (s.startFrame + s.frameCount) / clipFps,
      url:      `/media/${projectId}/generated/${encodeURIComponent(s.generatedVideo)}`,
      segId:    s.id,
    }))
    .sort((a, b) => a.startSec - b.startSec);
  overlayDone.clear();

  // Warm browser cache with preload link tags so overlays start without flash
  genSegments.forEach(seg => {
    if (!document.querySelector(`link[data-overlay-seg="${seg.segId}"]`)) {
      const link = document.createElement('link');
      link.rel  = 'preload';
      link.as   = 'video';
      link.href = seg.url;
      link.dataset.overlaySeg = seg.segId;
      document.head.appendChild(link);
    }
  });
}

export function playerToggleGenSeg(segId) {
  if (hiddenSegIds.has(segId)) {
    hiddenSegIds.delete(segId);
  } else {
    hiddenSegIds.add(segId);
  }
  // Reset overlay state and re-evaluate current position
  overlayVideo.pause();
  overlayVideo.hidden = true;
  overlayVideo.src = '';
  overlayDone.clear();

  const t = video.currentTime;
  const activeSeg = visibleSegs().find(s => t >= s.startSec && t < s.endSec);
  if (activeSeg) {
    overlayDone.add(activeSeg.startSec);
    const offsetSec = t - activeSeg.startSec;
    overlayVideo.src = activeSeg.url;
    overlayVideo.addEventListener('loadedmetadata', () => {
      overlayVideo.currentTime = offsetSec;
      overlayVideo.hidden = false;
      if (!video.paused) overlayVideo.play().catch(() => {});
    }, { once: true });
  }
}

// ── Overlay: play generated video on top of original ──────────
function checkOverlay() {
  if (!genSegments.length || video.paused) return;
  const t = video.currentTime;
  for (const seg of visibleSegs()) {
    if (t >= seg.startSec && !overlayDone.has(seg.startSec)) {
      overlayDone.add(seg.startSec);
      overlayVideo.src = seg.url;
      overlayVideo.hidden = false;
      overlayVideo.play().catch(() => {});
      break;
    }
  }
}

overlayVideo.addEventListener('ended', () => {
  overlayVideo.hidden = true;
  overlayVideo.src = '';
});

// On seek: clear ALL overlay state and re-evaluate from the new position.
// Previously only cleared segments at/after t, which left earlier segments in
// overlayDone permanently — clicking any frame past them meant they'd never
// trigger again.
video.addEventListener('seeked', () => {
  const t = video.currentTime;
  overlayDone.clear();
  overlayVideo.pause();
  overlayVideo.hidden = true;
  overlayVideo.src = '';

  // If we landed inside a generated segment, load overlay at the matching offset
  const activeSeg = visibleSegs().find(s => t >= s.startSec && t < s.endSec);
  if (activeSeg) {
    overlayDone.add(activeSeg.startSec);
    const offsetSec = t - activeSeg.startSec;
    overlayVideo.src = activeSeg.url;
    overlayVideo.addEventListener('loadedmetadata', () => {
      overlayVideo.currentTime = offsetSec;
      overlayVideo.hidden = false;
      if (!video.paused) overlayVideo.play().catch(() => {});
    }, { once: true });
  }
});

// ── Play / Pause ───────────────────────────────────────────────
btnPlay.addEventListener('click', togglePlay);

document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (['INPUT','TEXTAREA','SL-INPUT','SL-TEXTAREA'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  togglePlay();
});

function togglePlay() {
  if (!video.src || video.readyState < 2) return;
  video.paused ? video.play() : video.pause();
}

video.addEventListener('play', () => {
  btnPlay.textContent = '⏸ Pause';
  startTimecodeLoop();
  // Resume overlay if it was paused in sync with the main video
  if (!overlayVideo.hidden && overlayVideo.paused && overlayVideo.src) {
    overlayVideo.play().catch(() => {});
  }
});

video.addEventListener('pause', () => {
  btnPlay.textContent = '▶ Play Preview';
  stopTimecodeLoop();
  updateTimecode();
  // Pause overlay in sync
  if (!overlayVideo.hidden && !overlayVideo.paused) {
    overlayVideo.pause();
  }
});

video.addEventListener('ended', () => {
  btnPlay.textContent = '▶ Play Preview';
  stopTimecodeLoop();
  overlayVideo.pause();
  overlayVideo.hidden = true;
});

// ── Mute ───────────────────────────────────────────────────────
btnMute.addEventListener('click', () => {
  video.muted = !video.muted;
  iconSound.style.display = video.muted ? 'none'  : '';
  iconMuted.style.display = video.muted ? ''      : 'none';
});

// ── Timecode + playhead event ──────────────────────────────────
function startTimecodeLoop() {
  stopTimecodeLoop();
  function tick() {
    updateTimecode();
    dispatchTimeUpdate();
    checkOverlay();
    rafHandle = requestAnimationFrame(tick);
  }
  rafHandle = requestAnimationFrame(tick);
}

function stopTimecodeLoop() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

function updateTimecode() {
  const cur = video.currentTime || 0;
  const dur = video.duration   || 0;
  timecodeEl.textContent = `${toTC(cur, currentFps)} / ${toTC(dur, currentFps)}`;
}

function dispatchTimeUpdate() {
  if (!currentClip) return;
  document.dispatchEvent(new CustomEvent('player:timeupdate', {
    detail: { currentTime: video.currentTime, clipId: currentClip.id, fps: currentFps, isPlaying: !video.paused }
  }));
}

// Convert seconds → HH:MM:SS:FF
function toTC(sec, fps) {
  const totalFrames = Math.floor(sec * fps);
  const ff = totalFrames % Math.round(fps);
  const ss = Math.floor(sec)      % 60;
  const mm = Math.floor(sec / 60) % 60;
  const hh = Math.floor(sec / 3600);
  return [hh, mm, ss, ff].map(n => String(n).padStart(2, '0')).join(':');
}
