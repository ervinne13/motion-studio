import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, rm } from 'fs/promises';
import multer from 'multer';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

import { probeVideo, extractFrameRange, concatVideos } from './lib/video.js';
import { basename } from 'path';
import {
  createProject, loadProject, saveProject,
  computeSegments, uploadsDir, thumbsDir, projectDir,
} from './lib/project.js';
import { enqueue, getJob, getTodayJobs, subscribeJob, resumeOnStartup } from './lib/queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || './data';

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

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
app.get('/api/projects', async (_req, res) => {
  const dir = join(DATA_DIR, 'projects');
  try {
    const entries = await readdir(dir);
    const projects = [];
    for (const id of entries) {
      try {
        const p = await loadProject(id);
        projects.push({
          id:           p.id,
          name:         p.name || 'untitled',
          clipCount:    p.sourceClips?.length  ?? 0,
          segmentCount: p.segments?.length     ?? 0,
          mode:         p.mode,
        });
      } catch { /* skip corrupted */ }
    }
    res.json({ projects });
  } catch {
    res.json({ projects: [] });
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
    const allowed = ['name', 'mode', 'fps', 'aspectRatio', 'defaultPrompt', 'defaultSeed', 'genFps', 'genFramesPerSegment'];
    allowed.forEach(k => { if (req.body[k] !== undefined) project[k] = req.body[k]; });

    // Recompute segment boundaries when generation settings change
    if (req.body.genFps !== undefined || req.body.genFramesPerSegment !== undefined) {
      const genFps  = project.genFps  || 8;
      const genFrms = project.genFramesPerSegment || 81;
      project.segments = project.sourceClips.flatMap(clip =>
        computeSegments(clip.id, clip.totalFrames, clip.fps, genFps, genFrms)
      );
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
      const genFps  = project.genFps  || 8;
      const genFrms = project.genFramesPerSegment || 81;
      project.segments.push(...computeSegments(clipId, totalFrames, fps, genFps, genFrms));
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

// ── Generate (enqueue per segment) ────────────────────────────
// POST /api/project/:id/generate
// Body: { clipId, segmentSec, genFps, prompt, seed }
// Returns { jobs: [...] } — one job per segment, chained via dependsOn
app.post('/api/project/:id/generate', async (req, res) => {
  const { id } = req.params;
  const { clipId, prompt = '', seed } = req.body;

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
    const genFps         = project.genFps  || 8;

    // Project segments are the canonical segmentation — one job per segment
    const clipSegs = project.segments.filter(s => s.sourceClipId === clipId);

    let lastRef   = defaultRef;
    const jobs    = [];
    let prevJobId = null;
    const batchId = `${id.slice(0, 6)}-${Date.now()}`;

    for (let i = 0; i < clipSegs.length; i++) {
      const seg = clipSegs[i];
      if (seg.referenceImage) lastRef = seg.referenceImage;

      // Convert source-frame segment boundaries to gen-frame counts
      const genFrameCount  = Math.round(seg.frameCount  / clip.fps * genFps);
      const genStartFrame  = Math.round(seg.startFrame  / clip.fps * genFps);
      const outputPath     = join(outputDir, `seg${i + 1}_${batchId}.mp4`);

      const params = {
        segmentIndex:           i,
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
        outputPath,
        jobPrefix:              `motion-studio/${batchId}_seg${i + 1}`,
        clipFps:                clip.fps,
      };

      const job = await enqueue(params, prevJobId);
      prevJobId = job.id;
      jobs.push(job);
    }

    res.json({ jobs });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Export: concat all done segments ──────────────────────────
// POST /api/project/:id/export
app.post('/api/project/:id/export', async (req, res) => {
  const { id } = req.params;
  try {
    const project  = await loadProject(id);
    const genSegs  = project.segments.filter(s => s.generatedVideo);
    if (!genSegs.length) return res.status(400).json({ error: 'No generated segments to export' });

    const { mkdir } = await import('fs/promises');
    const genDir    = join(projectDir(id), 'generated');
    await mkdir(genDir, { recursive: true });

    const inputs    = genSegs.map(s => join(genDir, s.generatedVideo));
    const outFile   = `export_${Date.now()}.mp4`;
    const outputPath = join(genDir, outFile);

    await concatVideos(inputs, outputPath);
    res.json({ path: `/media/${id}/generated/${encodeURIComponent(outFile)}`, filename: outFile });
  } catch (e) {
    console.error('Export error:', e);
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

  if (job.status === 'done' || job.status === 'failed') {
    res.end();
    return;
  }

  const unsub = subscribeJob(jobId, updated => {
    send(updated);
    if (updated.status === 'done' || updated.status === 'failed') {
      unsub();
      res.end();
    }
  });

  req.on('close', unsub);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Motion Studio → http://localhost:${PORT}`);
  resumeOnStartup().catch(e => console.error('[queue] resumeOnStartup error:', e));
});
