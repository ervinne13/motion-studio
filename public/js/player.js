// ── Playlist-based single-video player ────────────────────────
// Plays segments in sequence using one <video> element.
// Each segment uses either its generated output or the relevant
// portion of the source clip; we switch src/currentTime at
// segment boundaries instead of stacking two overlapping elements.
//
// Flash prevention: a <canvas> overlay freezes the last decoded frame
// while the main video loads its next src, eliminating black-frame gaps.

const video       = document.getElementById('preview-video');
const videoBuf    = document.getElementById('preview-video-buf');
const previewArea = document.getElementById('preview-area');
const placeholder = document.getElementById('preview-placeholder');
const timecodeEl  = document.getElementById('timecode');
const btnPlay     = document.getElementById('btn-play-preview');
const btnMute     = document.getElementById('btn-mute');
const iconSound   = document.getElementById('icon-sound');
const iconMuted   = document.getElementById('icon-muted');
const audioEl     = document.getElementById('source-audio');

// ── Cover canvas — freezes last frame during src switch ────────
const coverCanvas = document.createElement('canvas');
coverCanvas.style.cssText = [
  'position:absolute', 'top:50%', 'left:50%',
  'transform:translate(-50%,-50%)',
  'max-width:calc(100% - 32px)', 'max-height:calc(100% - 32px)',
  'object-fit:contain', 'border-radius:4px',
  'z-index:5', 'display:none', 'pointer-events:none',
].join(';');
previewArea.appendChild(coverCanvas);
const coverCtx = coverCanvas.getContext('2d');
let _coverShown = false;

function _showCover() {
  if (video.videoWidth === 0 || _coverShown) return;
  coverCanvas.width  = video.videoWidth;
  coverCanvas.height = video.videoHeight;
  coverCtx.drawImage(video, 0, 0);
  coverCanvas.style.display = 'block';
  _coverShown = true;
}

function _hideCover() {
  if (!_coverShown) return;
  coverCanvas.style.display = 'none';
  _coverShown = false;
}

// ── Playlist state ─────────────────────────────────────────────
// playlist entries: { segId, src, localStart, localEnd,
//   globalStart, globalEnd, clipId, clipFps, sourceStartSec,
//   isGenerated, clipSrc }
let playlist    = [];
let playlistIdx = 0;
const hiddenSegIds = new Set();
let rafHandle   = null;
let _audioActive = false;

// Buffer preload state
let _bufIdx    = -1;
let _bufSeeked = false;

// ── Build / rebuild playlist ───────────────────────────────────
export function playerBuildPlaylist(segments, projectId, clips) {
  const prevGlobal = globalCurrentTime();
  const wasPlaying = !video.paused;

  let globalTime = 0;
  playlist = [];

  for (const seg of segments) {
    const clip = clips.find(c => c.id === seg.sourceClipId);
    if (!clip) continue;
    const clipFps    = clip.fps;
    const segDur     = seg.frameCount / clipFps;
    const globalStart = globalTime;
    const globalEnd   = globalTime + segDur;
    globalTime = globalEnd;

    const isGenerated = !!seg.generatedVideo && !hiddenSegIds.has(seg.id);
    const clipSrc     = `/media/${projectId}/uploads/${encodeURIComponent(clip.filename)}`;
    const src        = isGenerated
      ? `/media/${projectId}/generated/${encodeURIComponent(seg.generatedVideo)}`
      : clipSrc;
    const localStart = isGenerated ? 0 : seg.startFrame / clipFps;
    const localEnd   = isGenerated ? segDur : (seg.startFrame + seg.frameCount) / clipFps;

    playlist.push({
      segId: seg.id,
      src,
      localStart,
      localEnd,
      globalStart,
      globalEnd,
      clipId: clip.id,
      clipFps,
      sourceStartSec: seg.startFrame / clipFps,
      isGenerated,
      clipSrc,
    });
  }

  if (!playlist.length) return;

  placeholder.hidden = true;
  video.hidden       = false;
  btnPlay.disabled   = false;
  btnMute.disabled   = false;

  _bufIdx    = -1;
  _bufSeeked = false;
  startTimecodeLoop();

  if (!video.src || video.src === location.href) {
    _loadEntry(playlist[0], false, playlist[0].localStart);
    return;
  }

  _seekToGlobal(prevGlobal, wasPlaying);
}

export function playerToggleGenSeg(segId) {
  if (hiddenSegIds.has(segId)) hiddenSegIds.delete(segId);
  else hiddenSegIds.add(segId);
}

export function playerSeek(timeSec) {
  _seekToGlobal(timeSec);
  updateTimecode();
  dispatchTimeUpdate();
}

// ── Global time ────────────────────────────────────────────────
function globalCurrentTime() {
  const entry = playlist[playlistIdx];
  if (!entry) return video.currentTime || 0;
  return entry.globalStart + Math.max(0, (video.currentTime || 0) - entry.localStart);
}

function _seekToGlobal(globalTimeSec, autoplay) {
  if (!playlist.length) { video.currentTime = globalTimeSec; return; }
  let idx = playlist.findIndex(e => globalTimeSec >= e.globalStart && globalTimeSec < e.globalEnd);
  if (idx === -1)
    idx = globalTimeSec >= (playlist[playlist.length - 1]?.globalEnd ?? 0) ? playlist.length - 1 : 0;
  playlistIdx = idx;
  const entry    = playlist[idx];
  const localTime = entry.localStart + Math.max(0, globalTimeSec - entry.globalStart);
  _loadEntry(entry, autoplay ?? !video.paused, localTime);
}

// ── Load entry — canvas-freeze covers the src-switch gap ───────
function _loadEntry(entry, autoplay, seekTo) {
  // ── Audio ──────────────────────────────────────────────────
  if (entry.isGenerated) {
    const audioSec       = entry.sourceStartSec + Math.max(0, (seekTo ?? entry.localStart) - entry.localStart);
    const targetAudioSrc = new URL(entry.clipSrc, location.href).href;
    if (audioEl.src !== targetAudioSrc) {
      audioEl.src = entry.clipSrc;
      audioEl.addEventListener('loadedmetadata', () => {
        audioEl.currentTime = audioSec;
        if (autoplay) audioEl.play().catch(() => {});
      }, { once: true });
    } else {
      audioEl.currentTime = audioSec;
      if (autoplay && audioEl.paused) audioEl.play().catch(() => {});
    }
    audioEl.muted = video.muted;
    _audioActive  = true;
  } else {
    audioEl.pause();
    _audioActive = false;
  }

  // ── Video ──────────────────────────────────────────────────
  const targetSrc = new URL(entry.src, location.href).href;

  if (video.src === targetSrc) {
    if (seekTo !== undefined) video.currentTime = seekTo;
    if (autoplay && video.paused) video.play().catch(() => {});
    return;
  }

  // Freeze last frame — hides the gap while new src loads
  _showCover();

  video.src = entry.src;
  video.addEventListener('loadedmetadata', () => {
    const local = seekTo ?? entry.localStart;
    video.currentTime = local;

    const reveal = () => {
      if (autoplay) video.play().catch(() => {});
      // Two rAF passes so the browser has painted the new frame before we uncover
      requestAnimationFrame(() => requestAnimationFrame(_hideCover));
    };

    if (local > 0) {
      // Seek is async — wait for it to complete before revealing
      video.addEventListener('seeked', reveal, { once: true });
    } else {
      reveal();
    }
  }, { once: true });
}

// ── Preload next segment into videoBuf (secondary optimisation) ─
function _preloadBuf(idx) {
  if (_bufIdx === idx || idx >= playlist.length) return;
  _bufSeeked = false;
  const entry     = playlist[idx];
  const targetSrc = new URL(entry.src, location.href).href;
  const bufSrc    = videoBuf.src ? new URL(videoBuf.src, location.href).href : '';
  if (bufSrc !== targetSrc) videoBuf.src = entry.src;

  const doSeek = () => {
    videoBuf.currentTime = entry.localStart;
    videoBuf.addEventListener('seeked', () => { _bufSeeked = true; }, { once: true });
  };
  if (videoBuf.readyState >= 1) doSeek();
  else videoBuf.addEventListener('loadedmetadata', doSeek, { once: true });
  _bufIdx = idx;
}

// ── Advance to next segment ────────────────────────────────────
function checkAdvance() {
  const entry = playlist[playlistIdx];
  if (!entry || video.paused) return;

  // Audio drift correction
  if (entry.isGenerated && _audioActive && !audioEl.paused) {
    const expected = entry.sourceStartSec + (video.currentTime - entry.localStart);
    if (Math.abs(audioEl.currentTime - expected) > 0.3) audioEl.currentTime = expected;
  }

  // Preload next segment 2s before end
  if (entry.localEnd - (video.currentTime || 0) < 2 && playlistIdx + 1 < playlist.length)
    _preloadBuf(playlistIdx + 1);

  if ((video.currentTime || 0) >= entry.localEnd - 0.04) {
    if (playlistIdx < playlist.length - 1) {
      playlistIdx++;
      const next = playlist[playlistIdx];
      _loadEntry(next, true, next.localStart);
    } else {
      _seekToGlobal(0, true);
    }
  }
}

// ── Play / Pause ───────────────────────────────────────────────
btnPlay.addEventListener('click', togglePlay);
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  togglePlay();
});

function togglePlay() {
  if (!video.src || video.readyState < 2) return;
  video.paused ? video.play() : video.pause();
}

video.addEventListener('play', () => {
  btnPlay.textContent = 'Pause Preview';
  startTimecodeLoop();
  if (_audioActive) audioEl.play().catch(() => {});
});
video.addEventListener('pause', () => {
  btnPlay.textContent = '▶ Play Preview';
  stopTimecodeLoop();
  updateTimecode();
  audioEl.pause();
});
video.addEventListener('ended', () => {
  if (playlistIdx < playlist.length - 1) {
    playlistIdx++;
    _loadEntry(playlist[playlistIdx], true, playlist[playlistIdx].localStart);
  } else {
    _seekToGlobal(0, true);
  }
});

// ── Fullscreen ─────────────────────────────────────────────────
document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else previewArea.requestFullscreen?.();
});
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const inFs = !!document.fullscreenElement;
  btn.title = inFs ? 'Exit fullscreen' : 'Fullscreen';
  btn.querySelector('svg').innerHTML = inFs
    ? '<path fill-rule="evenodd" d="M5 4a1 1 0 00-1 1v2a1 1 0 01-2 0V5a3 3 0 013-3h2a1 1 0 010 2H5zm10 0h-2a1 1 0 010-2h2a3 3 0 013 3v2a1 1 0 01-2 0V5a1 1 0 00-1-1zM4 15a1 1 0 001 1h2a1 1 0 010 2H5a3 3 0 01-3-3v-2a1 1 0 012 0v2zm12 1a1 1 0 001-1v-2a1 1 0 012 0v2a3 3 0 01-3 3h-2a1 1 0 010-2h2z" clip-rule="evenodd"/>'
    : '<path fill-rule="evenodd" d="M3 4a1 1 0 011-1h4a1 1 0 010 2H5.414l2.293 2.293a1 1 0 01-1.414 1.414L4 6.414V8a1 1 0 01-2 0V4zm13 0a1 1 0 00-1-1h-4a1 1 0 000 2h2.586l-2.293 2.293a1 1 0 001.414 1.414L15 6.414V8a1 1 0 002 0V4zM4 16a1 1 0 001 1h4a1 1 0 000-2H6.586l2.293-2.293a1 1 0 00-1.414-1.414L5 13.586V12a1 1 0 00-2 0v4zm13 0a1 1 0 01-1 1h-4a1 1 0 010-2h2.586l-2.293-2.293a1 1 0 011.414-1.414L15 13.586V12a1 1 0 012 0v4z" clip-rule="evenodd"/>';
});

// ── Mute ───────────────────────────────────────────────────────
btnMute.addEventListener('click', () => {
  video.muted       = !video.muted;
  audioEl.muted     = video.muted;
  iconSound.style.display = video.muted ? 'none' : '';
  iconMuted.style.display = video.muted ? ''     : 'none';
});

// ── Timecode loop ──────────────────────────────────────────────
function startTimecodeLoop() {
  stopTimecodeLoop();
  function tick() { updateTimecode(); dispatchTimeUpdate(); checkAdvance(); rafHandle = requestAnimationFrame(tick); }
  rafHandle = requestAnimationFrame(tick);
}
function stopTimecodeLoop() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

function updateTimecode() {
  const globalTime = globalCurrentTime();
  const totalDur   = playlist.length > 0 ? playlist[playlist.length - 1].globalEnd : (video.duration || 0);
  const fps        = playlist[playlistIdx]?.clipFps || 24;
  timecodeEl.textContent = `${toTC(globalTime, fps)} / ${toTC(totalDur, fps)}`;
}

function dispatchTimeUpdate() {
  const entry = playlist[playlistIdx];
  if (!entry) return;
  const cur        = video.currentTime || 0;
  const sourceTime = entry.localStart === 0 ? entry.sourceStartSec + cur : cur;
  document.dispatchEvent(new CustomEvent('player:timeupdate', {
    detail: { currentTime: sourceTime, clipId: entry.clipId, fps: entry.clipFps, isPlaying: !video.paused }
  }));
}

function toTC(sec, fps) {
  const f  = Math.floor(sec * fps);
  const ff = f % Math.round(fps);
  const ss = Math.floor(sec)       % 60;
  const mm = Math.floor(sec / 60)  % 60;
  const hh = Math.floor(sec / 3600);
  return [hh, mm, ss, ff].map(n => String(n).padStart(2, '0')).join(':');
}
