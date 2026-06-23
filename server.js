import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, rm, stat } from 'fs/promises';
import multer from 'multer';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

import { probeVideo, extractFrameRange, concatVideos, mixAudio } from './lib/video.js';
import { basename } from 'path';
import {
  createProject, loadProject, saveProject,
  computeSegments, uploadsDir, thumbsDir, projectDir,
} from './lib/project.js';
import { enqueue, getJob, getTodayJobs, subscribeJob, subscribeAll, cancelJob, forceRelease, resumeOnStartup } from './lib/queue.js';
import { generateQwenEdit } from './lib/generate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || './data';

app.use(express.json());

// Projects grid page — must come before express.static so / doesn't fall through to index.html
app.get('/',        (_req, res) => res.sendFile(join(__dirname, 'public', 'projects.html')));
app.get('/projects', (_req, res) => res.sendFile(join(__dirname, 'public', 'projects.html')));

app.use(express.static(join(__dirname, 'public')));
app.use('/shoelace', express.static(join(__dirname, 'node_modules/@shoelace-style/shoelace/dist')));

// Serve uploaded videos + thumbnails under /media/:projectId/...
app.use('/media/:projectId', (req, res, next) => {
  express.static(projectDir(req.params.projectId))(req, res, next);
});

// ── Multer ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, uploadsDir(req.params.id)),
  filename:    (_req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// ── Projects list ──────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  const dir = join(DATA_DIR, 'projects');
  const wantArchived = req.query.archived === 'true';
  try {
    const entries = await readdir(dir);
    const projects = [];
    let archivedCount = 0;
    for (const id of entries) {
      try {
        const p = await loadProject(id);
        const isArchived = p.archived === true;
        if (isArchived) archivedCount++;
        if (isArchived !== wantArchived) continue;
        const genAssets  = p.generatedAssets ?? [];
        const sortedGen  = [...genAssets].sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
        const firstGen   = sortedGen[0];
        const clipNames  = new Set((p.sourceClips ?? []).map(c => c.filename));
        const firstImage = (p.assets ?? []).find(a => !clipNames.has(a));
        const thumbnail  = firstGen
          ? { type: 'video', url: `/media/${p.id}/generated/${encodeURIComponent(firstGen.filename)}` }
          : firstImage
          ? { type: 'image', url: `/media/${p.id}/uploads/${encodeURIComponent(firstImage)}` }
          : null;
        const fileInfo = await stat(join(DATA_DIR, 'projects', id, 'project.json')).catch(() => null);
        projects.push({
          id:           p.id,
          name:         p.name || 'untitled',
          clipCount:    p.sourceClips?.length  ?? 0,
          segmentCount: p.segments?.length     ?? 0,
          doneCount:    p.segments?.filter(s => s.generatedVideo).length ?? 0,
          mode:         p.mode,
          thumbnail,
          updatedAt:    fileInfo?.mtime?.toISOString() ?? null,
        });
      } catch { /* skip corrupted */ }
    }
    res.json({ projects, archivedCount: wantArchived ? undefined : archivedCount });
  } catch {
    res.json({ projects: [], archivedCount: 0 });
  }
});

// ── Project CRUD ───────────────────────────────────────────────
app.post('/api/project', async (_req, res) => {
  try {
    res.json(await createProject());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/project/:id', async (req, res) => {
  try {
    res.json(await loadProject(req.params.id));
  } catch {
    res.status(404).json({ error: 'Project not found' });
  }
});

app.patch('/api/project/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    const allowed = ['name', 'mode', 'fps', 'aspectRatio', 'defaultPrompt', 'defaultSeed', 'genFps', 'genFramesPerSegment', 'archived'];
    allowed.forEach(k => { if (req.body[k] !== undefined) project[k] = req.body[k]; });

    // Recompute segment boundaries when generation settings change,
    // but only for clips that already have segments (assets-only clips stay out)
    if (req.body.genFps !== undefined || req.body.genFramesPerSegment !== undefined) {
      const genFps  = project.genFps  || 24;
      const genFrms = project.genFramesPerSegment || 81;
      const clipsWithSegs = new Set(project.segments.map(s => s.sourceClipId));
      project.segments = project.sourceClips
        .filter(clip => clipsWithSegs.has(clip.id))
        .flatMap(clip => computeSegments(clip.id, clip.totalFrames, clip.fps, genFps, genFrms));
    }

    await saveProject(project);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/project/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await rm(projectDir(id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Upload ─────────────────────────────────────────────────────
app.post('/api/project/:id/upload', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const file   = req.file;
  if (!file) return res.status(400).json({ error: 'No file' });

  try {
    const project  = await loadProject(id);
    const isVideo  = file.mimetype.startsWith('video/');
    const filePath = join(uploadsDir(id), file.originalname);

    if (isVideo) {
      const { fps, totalFrames } = await probeVideo(filePath);
      const clipId = `clip-${randomUUID().slice(0, 8)}`;
      project.sourceClips.push({ id: clipId, filename: file.originalname, fps, totalFrames });
      if (project.sourceClips.length === 1) project.fps = fps;
    }

    if (!project.assets.includes(file.originalname)) {
      project.assets.push(file.originalname);
    }

    await saveProject(project);
    res.json({ project, filename: file.originalname, isVideo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Thumbnails ─────────────────────────────────────────────────
// GET /api/project/:id/thumbnails?clipId=&start=&end=
app.get('/api/project/:id/thumbnails', async (req, res) => {
  const { id }                          = req.params;
  const { clipId, start = '0', end = '0' } = req.query;

  if (!clipId) return res.status(400).json({ error: 'clipId required' });

  try {
    const project = await loadProject(id);
    const clip    = project.sourceClips.find(c => c.id === clipId);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const s = Math.max(0, parseInt(start, 10));
    const e = Math.min(clip.totalFrames - 1, parseInt(end, 10));
    if (s > e) return res.json({ frames: [] });

    const videoPath = join(uploadsDir(id), clip.filename);
    const thumbDir  = join(thumbsDir(id), clipId);

    await extractFrameRange(videoPath, s, e, thumbDir, clip.fps);

    const frames = Array.from({ length: e - s + 1 }, (_, i) => ({
      frame: s + i,
      url:   `/media/${id}/thumbs/${clipId}/frame_${s + i}.jpg`,
    }));

    res.json({ frames });
  } catch (e) {
    console.error('Thumbnail error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Clip: append segments ──────────────────────────────────────
// Called when a user drags a second video onto the timeline trail.
// Creates segments for an existing clip and appends them to the project.
app.post('/api/project/:id/clips/:clipId/segments', async (req, res) => {
  const { id, clipId } = req.params;
  try {
    const project = await loadProject(id);
    const clip = project.sourceClips.find(c => c.id === clipId);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const genFps  = project.genFps  || 24;
    const genFrms = project.genFramesPerSegment || 81;
    const newSegs = computeSegments(clipId, clip.totalFrames, clip.fps, genFps, genFrms);
    project.segments.push(...newSegs);
    await saveProject(project);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Segment operations ─────────────────────────────────────────
app.patch('/api/project/:id/segments/:segId', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await loadProject(id);
    const seg = project.segments.find(s => s.id === segId);
    if (!seg) return res.status(404).json({ error: 'Segment not found' });
    const allowed = ['referenceImage', 'prompt', 'selected', 'generatedVideo'];
    allowed.forEach(k => { if (req.body[k] !== undefined) seg[k] = req.body[k]; });
    await saveProject(project);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/project/:id/generatedAssets
app.get('/api/project/:id/generatedAssets', async (req, res) => {
  try {
    const project = await loadProject(req.params.id);
    res.json({ generatedAssets: project.generatedAssets ?? [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/project/:id/generatedAssets/:assetId — remove file + entry, unassign if active
app.delete('/api/project/:id/generatedAssets/:assetId', async (req, res) => {
  const { id, assetId } = req.params;
  try {
    const project = await loadProject(id);
    if (!project.generatedAssets) project.generatedAssets = [];
    const asset = project.generatedAssets.find(a => a.id === assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    // Remove file from disk
    const { unlink } = await import('fs/promises');
    await unlink(join(projectDir(id), 'generated', asset.filename)).catch(() => {});

    // Remove from array
    project.generatedAssets = project.generatedAssets.filter(a => a.id !== assetId);

    // Unassign if it was the active video on its segment
    const seg = project.segments.find(s => s.id === asset.segId);
    if (seg?.generatedVideo === asset.filename) {
      // Try to assign next most-recent asset for this segment, else null
      const remaining = project.generatedAssets
        .filter(a => a.segId === asset.segId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      seg.generatedVideo = remaining[0]?.filename ?? null;
    }

    await saveProject(project);
    res.json({ project });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/project/:id/segments/:segId', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await loadProject(id);
    project.segments = project.segments.filter(s => s.id !== segId);
    await saveProject(project);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Snap n DOWN to the nearest (4k+1), minimum 1
function snapFloor4n1(n) {
  if (n < 1) return 1;
  return 4 * Math.floor((n - 1) / 4) + 1;
}

// POST /api/project/:id/segments/:segId/split
// Body: { atSourceFrame } — absolute source frame index within the clip
// Splits into left (floor-snapped) + right (remaining source frames)
app.post('/api/project/:id/segments/:segId/split', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await loadProject(id);
    const segIdx = project.segments.findIndex(s => s.id === segId);
    if (segIdx === -1) return res.status(404).json({ error: 'Segment not found' });

    const seg  = project.segments[segIdx];
    const clip = project.sourceClips.find(c => c.id === seg.sourceClipId);
    if (!clip) return res.status(400).json({ error: 'Source clip not found' });

    const { atSourceFrame } = req.body;
    if (atSourceFrame == null) return res.status(400).json({ error: 'atSourceFrame required' });

    const genFps  = project.genFps  ?? 24;
    const clipFps = clip.fps;

    const cursorRel = atSourceFrame - seg.startFrame;
    if (cursorRel <= 0 || cursorRel >= seg.frameCount) {
      return res.status(400).json({ error: 'Cursor is outside segment bounds' });
    }

    // Floor-snap the left gen frame count to nearest 4n+1
    const leftGenFrames    = snapFloor4n1(Math.round(cursorRel / clipFps * genFps));
    const leftSourceFrames = Math.round(leftGenFrames / genFps * clipFps);

    if (leftSourceFrames <= 0 || leftSourceFrames >= seg.frameCount) {
      return res.status(400).json({ error: 'Split would produce an empty segment' });
    }

    const leftSeg = {
      ...seg,
      frameCount:     leftSourceFrames,
      generatedVideo: null,
    };
    const rightSeg = {
      ...seg,
      id:             `seg-${randomUUID().slice(0, 8)}`,
      startFrame:     seg.startFrame + leftSourceFrames,
      frameCount:     seg.frameCount - leftSourceFrames,
      generatedVideo: null,
    };

    project.segments.splice(segIdx, 1, leftSeg, rightSeg);
    await saveProject(project);
    res.json({ project });
  } catch (e) {
    console.error('Split error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Segments bulk update ───────────────────────────────────────
// PATCH /api/project/:id/segments-bulk
// Body: { updates: [{ id, selected? }] }
app.patch('/api/project/:id/segments-bulk', async (req, res) => {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
    for (const u of updates) {
      const seg = project.segments.find(s => s.id === u.id);
      if (!seg) continue;
      if (u.selected !== undefined) seg.selected = u.selected;
    }
    await saveProject(project);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/project/:id/segments/:segId/duplicate
app.post('/api/project/:id/segments/:segId/duplicate', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await loadProject(id);
    const segIdx = project.segments.findIndex(s => s.id === segId);
    if (segIdx === -1) return res.status(404).json({ error: 'Segment not found' });
    const original = project.segments[segIdx];
    const dupe = {
      ...original,
      id: `seg-${randomUUID().slice(0, 8)}`,
      generatedVideo: null,
    };
    project.segments.splice(segIdx + 1, 0, dupe);
    await saveProject(project);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Generate (enqueue per segment) ────────────────────────────
// POST /api/project/:id/generate
// Body: { clipId, segmentSec, genFps, prompt, seed, segIds? }
// Returns { jobs: [...] } — one job per segment, chained via dependsOn
app.post('/api/project/:id/generate', async (req, res) => {
  const { id } = req.params;
  const { clipId, prompt = '', seed, segIds } = req.body;

  try {
    const project = await loadProject(id);
    const clip    = project.sourceClips.find(c => c.id === clipId);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const clipFileNames = new Set(project.sourceClips.map(c => c.filename));
    const defaultRef = project.projectReferenceImage
      || project.assets.find(a => !clipFileNames.has(a))
      || null;
    if (!defaultRef) return res.status(400).json({ error: 'No reference image found — upload an image first' });

    const { mkdir } = await import('fs/promises');
    const outputDir = join(projectDir(id), 'generated');
    await mkdir(outputDir, { recursive: true });

    const resolvedSeed   = seed ?? (project.defaultSeed > 0 ? project.defaultSeed : Math.floor(Math.random() * 2 ** 32));
    const resolvedPrompt = prompt || project.defaultPrompt || '';
    const genFps         = project.genFps  || 24;

    // Project segments are the canonical segmentation — one job per selected segment
    const allClipSegs = project.segments.filter(s => s.sourceClipId === clipId);
    const clipSegs = allClipSegs.filter(s =>
      segIds ? segIds.includes(s.id) : s.selected
    );

    let lastRef   = defaultRef;
    const jobs    = [];
    let prevJobId = null;
    const batchId = `${id.slice(0, 6)}-${Date.now()}`;

    // If the first selected segment is mid-stream, seed prevComfyFilename from the previous segment's stored value
    const firstSegmentIndex = clipSegs.length ? allClipSegs.indexOf(clipSegs[0]) : 0;
    let batchStartPrevComfy = firstSegmentIndex > 0
      ? (allClipSegs[firstSegmentIndex - 1].comfyInputFilename ?? null)
      : null;

    for (let i = 0; i < clipSegs.length; i++) {
      const seg         = clipSegs[i];
      // Use position in the full clip segment list so extend workflow fires correctly
      const segmentIndex = allClipSegs.indexOf(seg);
      if (seg.referenceImage) lastRef = seg.referenceImage;

      // Convert source-frame segment boundaries to gen-frame counts
      const genFrameCount  = Math.round(seg.frameCount  / clip.fps * genFps);
      const genStartFrame  = Math.round(seg.startFrame  / clip.fps * genFps);
      const outputPath     = join(outputDir, `seg${segmentIndex + 1}_${batchId}.mp4`);

      const params = {
        segmentIndex,
        projectId:              id,
        projectName:            project.name || 'untitled',
        segId:                  seg.id,
        clipId,
        motionVideoPath:        join(uploadsDir(id), clip.filename),
        referenceImagePath:     join(uploadsDir(id), lastRef),
        referenceImageFilename: lastRef,
        genFps,
        frameCount:             genFrameCount,
        startFrame:             genStartFrame,
        prompt:                 resolvedPrompt,
        seed:                   resolvedSeed,
        mode:                   project.mode || 'subject-replacement',
        outputPath,
        jobPrefix:              `motion-studio/${batchId}_seg${segmentIndex + 1}`,
        clipFps:                clip.fps,
        // For the first job in a mid-stream batch, supply the prior segment's ComfyUI filename directly
        ...(i === 0 && batchStartPrevComfy ? { prevComfyFilename: batchStartPrevComfy } : {}),
      };

      const job = await enqueue(params, prevJobId);
      prevJobId = job.id;
      jobs.push(job);
      // Server-side hook: update segment when job completes (don't rely solely on browser SSE)
      subscribeJob(job.id, async updated => {
        if (updated.status === 'done') await syncJobToProject(updated).catch(() => {});
      });
    }

    res.json({ jobs });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Qwen frame edit ───────────────────────────────────────────
// POST /api/project/:id/frame-edit
app.post('/api/project/:id/frame-edit', async (req, res) => {
  const { id } = req.params;
  const { clipId, frameIndex, prompt = '', supportImage, nsfw = false } = req.body;
  try {
    const project = await loadProject(id);
    const clip    = project.sourceClips.find(c => c.id === clipId);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const { mkdir } = await import('fs/promises');
    const upDir = uploadsDir(id);
    await mkdir(upDir, { recursive: true });

    const outFilename = `qwen-${nsfw ? 'nsfw' : 'safe'}-f${frameIndex}-${Date.now()}.png`;
    const outputPath  = join(upDir, outFilename);
    const videoPath   = join(upDir, clip.filename);
    const supportPath = supportImage ? join(upDir, supportImage) : null;
    const prefix      = `qwen-${nsfw ? 'aio' : 'safe'}-`;

    const job = await enqueue({
      jobType:      'qwen-edit',
      projectId:    id,
      projectName:  project.name || 'untitled',
      clipId,
      frameIndex,
      prompt,
      nsfw,
      videoPath,
      supportImagePath: supportPath,
      outputPath,
      prefix,
    });

    subscribeJob(job.id, async updated => {
      if (updated.status === 'done') await syncQwenJobToProject(updated).catch(() => {});
    });

    res.json({ jobId: job.id });
  } catch (err) {
    console.error('[frame-edit]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Export: concat all done segments ──────────────────────────
// POST /api/project/:id/export
app.post('/api/project/:id/export', async (req, res) => {
  const { id } = req.params;
  const { includeAudio = false } = req.body ?? {};
  try {
    const project  = await loadProject(id);
    const genSegs  = project.segments.filter(s => s.generatedVideo);
    if (!genSegs.length) return res.status(400).json({ error: 'No generated segments to export' });

    const { mkdir } = await import('fs/promises');
    const genDir    = join(projectDir(id), 'generated');
    await mkdir(genDir, { recursive: true });

    const inputs     = genSegs.map(s => join(genDir, s.generatedVideo));
    const stamp      = Date.now();
    const concatFile = `export_${stamp}_concat.mp4`;
    const concatPath = join(genDir, concatFile);

    await concatVideos(inputs, concatPath);

    let outFile  = `export_${stamp}.mp4`;
    let outPath  = join(genDir, outFile);

    if (includeAudio && project.sourceClips?.length) {
      const audioSource = join(projectDir(id), 'uploads', project.sourceClips[0].filename);
      await mixAudio(concatPath, audioSource, outPath);
      // clean up silent concat
      const { unlink } = await import('fs/promises');
      await unlink(concatPath).catch(() => {});
    } else {
      // rename concat → final (no audio mixing needed)
      const { rename } = await import('fs/promises');
      await rename(concatPath, outPath);
    }

    res.json({ path: `/media/${id}/generated/${encodeURIComponent(outFile)}`, filename: outFile });
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── List export files for a project ───────────────────────────
app.get('/api/project/:id/exports', async (req, res) => {
  const { id } = req.params;
  try {
    const { readdir } = await import('fs/promises');
    const genDir = join(projectDir(id), 'generated');
    let files;
    try { files = await readdir(genDir); } catch { files = []; }
    const exports = files
      .filter(f => f.startsWith('export_') && f.endsWith('.mp4') && !f.includes('_concat'))
      .sort().reverse();
    res.json({ exports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Jobs list (today) ──────────────────────────────────────────
app.get('/api/jobs', async (_req, res) => {
  try {
    res.json({ jobs: await getTodayJobs() });
  } catch {
    res.json({ jobs: [] });
  }
});

// ── Job status ─────────────────────────────────────────────────
app.get('/api/jobs/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

// SSE global stream — one connection covers all job updates
app.get('/api/jobs/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = job => res.write(`data: ${JSON.stringify(job)}\n\n`);

  // Send current state of all non-terminal jobs immediately
  try {
    const jobs = await getTodayJobs();
    jobs.filter(j => !['done', 'failed', 'cancelled'].includes(j.status)).forEach(send);
  } catch { /* ignore */ }

  const unsub = subscribeAll(send);
  req.on('close', unsub);
});

// SSE stream for a specific job — sends updates until done/failed
app.get('/api/jobs/:jobId/stream', async (req, res) => {
  const { jobId } = req.params;
  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Send current state immediately
  send(job);

  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    res.end();
    return;
  }

  const unsub = subscribeJob(jobId, updated => {
    send(updated);
    if (updated.status === 'done' || updated.status === 'failed' || updated.status === 'cancelled') {
      unsub();
      res.end();
    }
  });

  req.on('close', unsub);
});

app.delete('/api/jobs/:jobId', async (req, res) => {
  const job = await cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

app.post('/api/jobs/:jobId/retry', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await cancelJob(jobId);
    forceRelease(jobId);
    const newJob = await enqueue(job.params);
    res.json({ job: newJob });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Client-side routes (serve HTML shells) ─────────────────────
app.get('/projects/:id', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/mobile',       (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'mobile.html')));
app.get('/logs',         (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'logs.html')));
app.get('/logs/:jobId',  (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'logs.html')));

// ── Server-side job→project sync ───────────────────────────────
async function syncQwenJobToProject(job) {
  if (job.status !== 'done' || !job.result?.outputPath) return;
  const { projectId, clipId, frameIndex } = job.params ?? {};
  if (!projectId) return;
  try {
    const project  = await loadProject(projectId);
    const filename = job.result.outputPath.split('/').pop();

    if (!project.assets.includes(filename)) project.assets.push(filename);

    const key  = `${clipId}:${frameIndex}`;
    if (!project.frameEdits) project.frameEdits = {};
    const edit = project.frameEdits[key] || { result: null, history: [] };
    if (edit.result && edit.result !== filename) edit.history.push(edit.result);
    edit.result = filename;
    project.frameEdits[key] = edit;

    await saveProject(project);
  } catch { /* project may have been deleted */ }
}

async function syncJobToProject(job) {
  if (job.status !== 'done' || !job.result?.outputPath) return;
  const { segId, projectId, segmentIndex } = job.params ?? {};
  if (!segId || !projectId) return;
  try {
    const { access } = await import('fs/promises');
    try { await access(job.result.outputPath); } catch {
      console.warn(`[server] syncJobToProject: output file missing at ${job.result.outputPath}, skipping segment update`);
      return;
    }

    const project  = await loadProject(projectId);
    const seg      = project.segments.find(s => s.id === segId);
    if (!seg) return;

    const filename = job.result.outputPath.split('/').pop();
    if (!project.generatedAssets) project.generatedAssets = [];

    // Determine version number (how many assets already exist for this segment)
    const existing = project.generatedAssets.filter(a => a.segId === segId);
    const version  = existing.length; // 0 = "Seg N", 1 = "Seg N.1", etc.

    // Add asset if not already tracked
    const alreadyTracked = project.generatedAssets.some(a => a.filename === filename);
    if (!alreadyTracked) {
      project.generatedAssets.push({
        id:           `ga-${randomUUID().slice(0, 8)}`,
        filename,
        segId,
        segmentIndex: segmentIndex ?? project.segments.indexOf(seg),
        version,
        createdAt:    new Date().toISOString(),
      });
    }

    // Always assign as active and update comfyInputFilename
    seg.generatedVideo = filename;
    if (job.result.comfyInputFilename) seg.comfyInputFilename = job.result.comfyInputFilename;

    await saveProject(project);
    console.log(`[server] synced ${filename} → ${segId} (v${version})`);
  } catch { /* project may have been deleted */ }
}

app.listen(PORT, async () => {
  console.log(`Motion Studio → http://localhost:${PORT}`);
  // Sync any segments whose jobs finished while server/browser was down
  try {
    const jobs = await getTodayJobs();
    for (const job of jobs) {
      if (job.params?.jobType === 'qwen-edit') await syncQwenJobToProject(job);
      else await syncJobToProject(job);
    }
  } catch {}
  resumeOnStartup().catch(e => console.error('[queue] resumeOnStartup error:', e));
});
