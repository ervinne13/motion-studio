// ── Playlist-based single-video player ────────────────────────
// Plays segments in sequence using one <video> element.
// Each segment uses either its generated output or the relevant
// portion of the source clip; we switch src/currentTime at
// segment boundaries instead of stacking two overlapping elements.

const video       = document.getElementById('preview-video');
const placeholder = document.getElementById('preview-placeholder');
const timecodeEl  = document.getElementById('timecode');
const btnPlay     = document.getElementById('btn-play-preview');
const btnMute     = document.getElementById('btn-mute');
const iconSound   = document.getElementById('icon-sound');
const iconMuted   = document.getElementById('icon-muted');

// ── Playlist state ─────────────────────────────────────────────
// playlist entries: { segId, src, localStart, localEnd,
//   globalStart, globalEnd, clipId, clipFps, sourceStartSec }
let playlist    = [];
let playlistIdx = 0;
const hiddenSegIds = new Set();
let rafHandle   = null;

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
    const src        = isGenerated
      ? `/media/${projectId}/generated/${encodeURIComponent(seg.generatedVideo)}`
      : `/media/${projectId}/uploads/${encodeURIComponent(clip.filename)}`;
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
    });
  }

  if (!playlist.length) return;

  placeholder.hidden = true;
  video.hidden       = false;
  btnPlay.disabled   = false;
  btnMute.disabled   = false;

  startTimecodeLoop();

  // On first load, point at the first entry
  if (!video.src || video.src === location.href) {
    _loadEntry(playlist[0], false, playlist[0].localStart);
    return;
  }

  // After a rebuild (e.g. gen-toggle), re-seek to same global position
  _seekToGlobal(prevGlobal, wasPlaying);
}

export function playerToggleGenSeg(segId) {
  if (hiddenSegIds.has(segId)) {
    hiddenSegIds.delete(segId);
  } else {
    hiddenSegIds.add(segId);
  }
  // Caller must call playerBuildPlaylist() to apply the change
}

// ── Seek (accepts source-clip time; equals global time for single-clip projects) ──
export function playerSeek(timeSec) {
  _seekToGlobal(timeSec);
  updateTimecode();
  dispatchTimeUpdate();
}

// ── Global time helpers ────────────────────────────────────────
function globalCurrentTime() {
  const entry = playlist[playlistIdx];
  if (!entry) return video.currentTime || 0;
  return entry.globalStart + Math.max(0, (video.currentTime || 0) - entry.localStart);
}

function _seekToGlobal(globalTimeSec, autoplay) {
  if (!playlist.length) {
    video.currentTime = globalTimeSec;
    return;
  }
  let idx = playlist.findIndex(e => globalTimeSec >= e.globalStart && globalTimeSec < e.globalEnd);
  if (idx === -1) {
    idx = globalTimeSec >= (playlist[playlist.length - 1]?.globalEnd ?? 0)
      ? playlist.length - 1 : 0;
  }
  playlistIdx = idx;
  const entry    = playlist[idx];
  const localTime = entry.localStart + Math.max(0, globalTimeSec - entry.globalStart);
  _loadEntry(entry, autoplay ?? !video.paused, localTime);
}

function _loadEntry(entry, autoplay, seekTo) {
  const targetSrc = new URL(entry.src, location.href).href;
  if (video.src === targetSrc) {
    if (seekTo !== undefined) video.currentTime = seekTo;
    if (autoplay && video.paused) video.play().catch(() => {});
  } else {
    video.src = entry.src;
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = seekTo ?? entry.localStart;
      if (autoplay) video.play().catch(() => {});
    }, { once: true });
  }
}

// ── Advance to next segment at end of current entry ────────────
function checkAdvance() {
  const entry = playlist[playlistIdx];
  if (!entry || video.paused) return;
  if ((video.currentTime || 0) >= entry.localEnd - 0.04) {
    if (playlistIdx < playlist.length - 1) {
      playlistIdx++;
      const next = playlist[playlistIdx];
      _loadEntry(next, true, next.localStart);
    } else {
      video.pause();
    }
  }
}

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

video.addEventListener('play',  () => { btnPlay.textContent = '⏸ Pause'; startTimecodeLoop(); });
video.addEventListener('pause', () => { btnPlay.textContent = '▶ Play Preview'; stopTimecodeLoop(); updateTimecode(); });
video.addEventListener('ended', () => {
  if (playlistIdx < playlist.length - 1) {
    // Intermediate segment: advance to next
    playlistIdx++;
    const next = playlist[playlistIdx];
    _loadEntry(next, true, next.localStart);
  } else {
    btnPlay.textContent = '▶ Play Preview';
    stopTimecodeLoop();
  }
});

// ── Mute ───────────────────────────────────────────────────────
btnMute.addEventListener('click', () => {
  video.muted = !video.muted;
  iconSound.style.display = video.muted ? 'none' : '';
  iconMuted.style.display = video.muted ? ''     : 'none';
});

// ── Timecode + playhead loop ───────────────────────────────────
function startTimecodeLoop() {
  stopTimecodeLoop();
  function tick() {
    updateTimecode();
    dispatchTimeUpdate();
    checkAdvance();
    rafHandle = requestAnimationFrame(tick);
  }
  rafHandle = requestAnimationFrame(tick);
}

function stopTimecodeLoop() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

function updateTimecode() {
  const globalTime = globalCurrentTime();
  const totalDur   = playlist.length > 0
    ? playlist[playlist.length - 1].globalEnd
    : (video.duration || 0);
  const fps = playlist[playlistIdx]?.clipFps || 24;
  timecodeEl.textContent = `${toTC(globalTime, fps)} / ${toTC(totalDur, fps)}`;
}

function dispatchTimeUpdate() {
  const entry = playlist[playlistIdx];
  if (!entry) return;
  // Map video.currentTime back to source-clip time so the timeline playhead
  // can find the right frame within the original clip coordinate system.
  // Source segments: video.currentTime already IS the source-clip time.
  // Generated segments: offset from segment start + sourceStartSec.
  const cur = video.currentTime || 0;
  const sourceTime = entry.localStart === 0
    ? entry.sourceStartSec + cur          // generated: localStart=0, cur=offset in gen video
    : cur;                                 // source: cur is already source-clip time
  document.dispatchEvent(new CustomEvent('player:timeupdate', {
    detail: { currentTime: sourceTime, clipId: entry.clipId, fps: entry.clipFps, isPlaying: !video.paused }
  }));
}

function toTC(sec, fps) {
  const totalFrames = Math.floor(sec * fps);
  const ff = totalFrames % Math.round(fps);
  const ss = Math.floor(sec)      % 60;
  const mm = Math.floor(sec / 60) % 60;
  const hh = Math.floor(sec / 3600);
  return [hh, mm, ss, ff].map(n => String(n).padStart(2, '0')).join(':');
}
