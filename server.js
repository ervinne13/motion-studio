import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, rm, stat, cp } from 'fs/promises';
import multer from 'multer';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

import { probeVideo, extractFrameRange, concatVideos, mixAudio, convertFps, splitVideoAtFrame, hasAudioStream } from './lib/video.js';
import { basename } from 'path';
import {
  createProject, loadProject, saveProject, withProjectLock,
  computeSegments, uploadsDir, thumbsDir, projectDir,
} from './lib/project.js';
import { enqueue, getJob, getTodayJobs, getAllDoneJobs, subscribeJob, subscribeAll, cancelJob, forceRelease, resumeOnStartup, pauseAllJobs, resumeAllJobs, isQueuePaused } from './lib/queue.js';
import { generateQwenEdit } from './lib/generate.js';
import { uploadVideo as comfyUploadVideo } from './lib/comfyui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || './data';

app.use(express.json());

// Projects grid page — must come before express.static so / doesn't fall through to index.html
app.get('/',          (_req, res) => res.sendFile(join(__dirname, 'public', 'projects.html')));
app.get('/projects',  (_req, res) => res.sendFile(join(__dirname, 'public', 'projects.html')));
app.get('/generate',  (_req, res) => res.sendFile(join(__dirname, 'public', 'generate.html')));

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
        const preview2xPath = join(DATA_DIR, 'projects', id, 'generated', 'preview_2x.mp4');
        const has2xPreview  = await stat(preview2xPath).then(() => true).catch(() => false);
        const thumbnail = has2xPreview
          ? { type: 'video', url: `/media/${p.id}/generated/preview_2x.mp4` }
          : firstGen
          ? { type: 'video', url: `/media/${p.id}/generated/${encodeURIComponent(firstGen.filename)}` }
          : firstImage
          ? { type: 'image', url: `/media/${p.id}/uploads/${encodeURIComponent(firstImage)}` }
          : null;
        const fileInfo = await stat(join(DATA_DIR, 'projects', id, 'project.json')).catch(() => null);
        // First segment reference image (for image-preview mode on the projects page)
        const firstRefFile = p.segments?.find(s => s.referenceImage)?.referenceImage ?? firstImage ?? null;
        const refImage = firstRefFile
          ? { url: `/media/${p.id}/uploads/${encodeURIComponent(firstRefFile)}` }
          : null;
        projects.push({
          id:           p.id,
          name:         p.name || 'untitled',
          clipCount:    p.sourceClips?.length  ?? 0,
          segmentCount: p.segments?.length     ?? 0,
          doneCount:    p.segments?.filter(s => s.generatedVideo).length ?? 0,
          mode:         p.mode,
          thumbnail,
          refImage,
          createdAt:    p.createdAt ?? null,
          updatedAt:    p.updatedAt ?? fileInfo?.mtime?.toISOString() ?? null,
          hasRender:    has2xPreview,
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
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      const allowed = ['name', 'mode', 'fps', 'aspectRatio', 'defaultPrompt', 'defaultSeed', 'genFps', 'genFramesPerSegment', 'useSourceFps', 'archived', 'megapixels', 'retryOnFailure'];
      allowed.forEach(k => { if (req.body[k] !== undefined) project[k] = req.body[k]; });

      if (req.body.genFps !== undefined || req.body.genFramesPerSegment !== undefined || req.body.useSourceFps !== undefined) {
        const genFrms = project.genFramesPerSegment || 81;
        const clipsWithSegs = new Set(project.segments.map(s => s.sourceClipId));
        project.segments = project.sourceClips
          .filter(clip => clipsWithSegs.has(clip.id))
          .flatMap(clip => {
            const genFps = project.useSourceFps ? clip.fps : (project.genFps || 24);
            return computeSegments(clip.id, clip.totalFrames, clip.fps, genFps, genFrms);
          });
      }

      await saveProject(project);
      return project;
    });
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

// ── Duplicate project ──────────────────────────────────────────
app.post('/api/project/:id/duplicate', async (req, res) => {
  const { id } = req.params;
  try {
    const src = await loadProject(id);

    // Build a unique copy name: "Name Copy", "Name Copy 2", …
    const baseName = src.name.replace(/ Copy(?: \d+)?$/, '');
    const allProjects = await readdir(join(DATA_DIR, 'projects'));
    const existingNames = new Set();
    for (const pid of allProjects) {
      try { const p = await loadProject(pid); existingNames.add(p.name); } catch { /* skip */ }
    }
    let copyName = `${baseName} Copy`;
    let n = 2;
    while (existingNames.has(copyName)) { copyName = `${baseName} Copy ${n++}`; }

    // New project directory
    const newId = randomUUID().slice(0, 8);
    const srcDir = projectDir(id);
    const dstDir = projectDir(newId);
    await cp(srcDir, dstDir, { recursive: true });

    // Patch the copied project.json
    const newProject = { ...src, id: newId, name: copyName, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    // Clear generated assets and segment results so it starts fresh
    newProject.generatedAssets = [];
    newProject.segments = (src.segments ?? []).map(s => ({ ...s, generatedVideo: null, id: `seg-${randomUUID().slice(0, 8)}` }));

    await saveProject(newProject);
    res.json(newProject);
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
    const isVideo  = file.mimetype.startsWith('video/');
    const filePath = join(uploadsDir(id), file.originalname);

    // Probe video outside the lock (can be slow)
    let videoMeta = null;
    if (isVideo) videoMeta = await probeVideo(filePath);

    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      if (isVideo) {
        const clipId = `clip-${randomUUID().slice(0, 8)}`;
        project.sourceClips.push({ id: clipId, filename: file.originalname, fps: videoMeta.fps, totalFrames: videoMeta.totalFrames });
        if (project.sourceClips.length === 1) project.fps = videoMeta.fps;
      }
      if (!project.assets.includes(file.originalname)) project.assets.push(file.originalname);
      await saveProject(project);
      return project;
    });
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

// Pattern: clips converted by us end with _<fps>fps.<ext>
const CONV_RE = /(_(\d+(?:\.\d+)?)fps)(\.[^.]+)$/;

// Repair a clip file that was FPS-converted but had audio stripped (old bug).
// Finds the original file beside it and re-converts with audio preserved.
async function repairClipAudio(clipPath) {
  if (await hasAudioStream(clipPath)) return; // already fine
  const m = clipPath.match(CONV_RE);
  if (!m) return;
  const origPath = clipPath.replace(CONV_RE, '$3'); // strip the _Nfps part
  try {
    const { access: fsAccess } = await import('fs/promises');
    await fsAccess(origPath);
    console.log(`[clip] repairing audio: re-converting ${origPath} → ${clipPath}`);
    await convertFps(origPath, clipPath, parseFloat(m[2]));
  } catch { /* original gone or conversion failed — nothing we can do */ }
}

app.post('/api/project/:id/clips/:clipId/segments', async (req, res) => {
  const { id, clipId } = req.params;
  try {
    // Read clip info outside the lock so we can do slow FPS conversion without blocking saves
    const projectSnap = await loadProject(id);
    const clipSnap = projectSnap.sourceClips.find(c => c.id === clipId);
    if (!clipSnap) return res.status(404).json({ error: 'Clip not found' });

    const genFps  = projectSnap.useSourceFps ? clipSnap.fps : (projectSnap.genFps || 24);
    const genFrms = projectSnap.genFramesPerSegment || 81;
    const clipPath = join(uploadsDir(id), clipSnap.filename);

    await repairClipAudio(clipPath).catch(() => {});

    // FPS conversion is slow — do it outside the lock
    let convResult = null;
    if (!projectSnap.useSourceFps && Math.abs(clipSnap.fps - genFps) > 0.01) {
      try {
        const dotIdx  = clipSnap.filename.lastIndexOf('.');
        const base    = dotIdx >= 0 ? clipSnap.filename.slice(0, dotIdx) : clipSnap.filename;
        const ext     = dotIdx >= 0 ? clipSnap.filename.slice(dotIdx) : '.mp4';
        const newName = `${base}_${genFps}fps${ext}`;
        const newPath = join(uploadsDir(id), newName);
        await convertFps(clipPath, newPath, genFps);
        const { fps: newFps, totalFrames: newTotal } = await probeVideo(newPath);
        convResult = { newName, newFps, newTotal };
      } catch (convErr) {
        console.warn('[segments] FPS conversion failed, using original:', convErr.message);
      }
    }

    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      const clip = project.sourceClips.find(c => c.id === clipId);
      if (!clip) throw new Error('Clip not found');
      if (convResult) {
        clip.filename    = convResult.newName;
        clip.fps         = convResult.newFps;
        clip.totalFrames = convResult.newTotal;
        if (!project.assets.includes(convResult.newName)) project.assets.push(convResult.newName);
      }
      const newSegs = computeSegments(clipId, clip.totalFrames, clip.fps, genFps, genFrms);
      project.segments.push(...newSegs);
      await saveProject(project);
      return project;
    });
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Segment operations ─────────────────────────────────────────
app.patch('/api/project/:id/segments/:segId', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      const seg = project.segments.find(s => s.id === segId);
      if (!seg) { const e = new Error('Segment not found'); e.status = 404; throw e; }
      const allowed = ['referenceImage', 'prompt', 'selected', 'generatedVideo', 'useBaseWorkflow'];
      allowed.forEach(k => { if (req.body[k] !== undefined) seg[k] = req.body[k]; });
      await saveProject(project);
      return project;
    });
    res.json({ project });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// POST /api/project/:id/resync — re-run syncJobToProject for all done jobs matching this project
app.post('/api/project/:id/resync', async (req, res) => {
  try {
    const jobs = await getAllDoneJobs();
    const relevant = jobs.filter(j => j.params?.projectId === req.params.id);
    let synced = 0;
    for (const job of relevant) {
      if (job.params?.jobType === 'qwen-edit') await syncQwenJobToProject(job);
      else await syncJobToProject(job);
      synced++;
    }
    const project = await loadProject(req.params.id);
    res.json({ synced, project });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      if (!project.generatedAssets) project.generatedAssets = [];
      const asset = project.generatedAssets.find(a => a.id === assetId);
      if (!asset) { const e = new Error('Asset not found'); e.status = 404; throw e; }

      const { unlink } = await import('fs/promises');
      await unlink(join(projectDir(id), 'generated', asset.filename)).catch(() => {});

      project.generatedAssets = project.generatedAssets.filter(a => a.id !== assetId);

      const seg = project.segments.find(s => s.id === asset.segId);
      if (seg?.generatedVideo === asset.filename) {
        const remaining = project.generatedAssets
          .filter(a => a.segId === asset.segId)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        seg.generatedVideo = remaining[0]?.filename ?? null;
      }

      await saveProject(project);
      return project;
    });
    res.json({ project });
  } catch (e) { res.status(e.status ?? 500).json({ error: e.message }); }
});

app.delete('/api/project/:id/segments', async (req, res) => {
  const { id } = req.params;
  try {
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      project.segments = [];
      project.sourceClips = [];
      await saveProject(project);
      return project;
    });
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/project/:id/segments/:segId', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      project.segments = project.segments.filter(s => s.id !== segId);
      await saveProject(project);
      return project;
    });
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
    const project = await withProjectLock(id, async () => {
    const project = await loadProject(id);
    const segIdx = project.segments.findIndex(s => s.id === segId);
    if (segIdx === -1) { const e = new Error('Segment not found'); e.status = 404; throw e; }

    const seg  = project.segments[segIdx];
    const clip = project.sourceClips.find(c => c.id === seg.sourceClipId);
    if (!clip) { const e = new Error('Source clip not found'); e.status = 400; throw e; }

    const { atSourceFrame } = req.body;
    if (atSourceFrame == null) { const e = new Error('atSourceFrame required'); e.status = 400; throw e; }

    const genFps  = project.useSourceFps ? clip.fps : (project.genFps ?? 24);
    const clipFps = clip.fps;

    const cursorRel = atSourceFrame - seg.startFrame;
    if (cursorRel <= 0 || cursorRel >= seg.frameCount) {
      const e = new Error('Cursor is outside segment bounds'); e.status = 400; throw e;
    }

    const leftGenFrames    = snapFloor4n1(Math.round(cursorRel / clipFps * genFps));
    const leftSourceFrames = Math.round(leftGenFrames / genFps * clipFps);

    if (leftSourceFrames <= 0 || leftSourceFrames >= seg.frameCount) {
      const e = new Error('Split would produce an empty segment'); e.status = 400; throw e;
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

    // If the original segment had a generated video, split it at the same boundary
    if (seg.generatedVideo) {
      try {
        const genDir       = join(projectDir(id), 'generated');
        const origGenPath  = join(genDir, seg.generatedVideo);
        const stamp        = Date.now();
        const leftGenFile  = `split-L-${stamp}-${leftSeg.id}.mp4`;
        const rightGenFile = `split-R-${stamp}-${rightSeg.id}.mp4`;

        await splitVideoAtFrame(origGenPath, join(genDir, leftGenFile), join(genDir, rightGenFile), leftGenFrames);

        leftSeg.generatedVideo  = leftGenFile;
        rightSeg.generatedVideo = rightGenFile;

        if (!project.generatedAssets) project.generatedAssets = [];

        // Remove the original segment's asset entry (its segId no longer exists)
        project.generatedAssets = project.generatedAssets.filter(a => a.segId !== segId);

        // Add entries for the two new segments
        project.generatedAssets.push(
          { id: `ga-${randomUUID().slice(0, 8)}`, filename: leftGenFile,  segId: leftSeg.id,  segmentIndex: segIdx,     version: 0, createdAt: new Date().toISOString() },
          { id: `ga-${randomUUID().slice(0, 8)}`, filename: rightGenFile, segId: rightSeg.id, segmentIndex: segIdx + 1, version: 0, createdAt: new Date().toISOString() },
        );
      } catch (splitErr) {
        console.warn('[split] generated video split failed, clearing generatedVideo:', splitErr.message);
      }
    }

    project.segments.splice(segIdx, 1, leftSeg, rightSeg);
    await saveProject(project);
    return project;
    }); // end withProjectLock
    res.json({ project });
  } catch (e) {
    console.error('Split error:', e);
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ── Segments bulk update ───────────────────────────────────────
// PATCH /api/project/:id/segments-bulk
// Body: { updates: [{ id, selected? }] }
app.patch('/api/project/:id/segments-bulk', async (req, res) => {
  const { id } = req.params;
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      for (const u of updates) {
        const seg = project.segments.find(s => s.id === u.id);
        if (!seg) continue;
        if (u.selected !== undefined) seg.selected = u.selected;
      }
      await saveProject(project);
      return project;
    });
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/project/:id/segments/:segId/duplicate
app.post('/api/project/:id/segments/:segId/duplicate', async (req, res) => {
  const { id, segId } = req.params;
  try {
    const project = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      const segIdx = project.segments.findIndex(s => s.id === segId);
      if (segIdx === -1) { const e = new Error('Segment not found'); e.status = 404; throw e; }
      const dupe = { ...project.segments[segIdx], id: `seg-${randomUUID().slice(0, 8)}`, generatedVideo: null };
      project.segments.splice(segIdx + 1, 0, dupe);
      await saveProject(project);
      return project;
    });
    res.json({ project });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ── Generate (enqueue per segment) ────────────────────────────
// POST /api/project/:id/generate
// Body: { clipId, segmentSec, genFps, prompt, seed, segIds? }
// Returns { jobs: [...] } — one job per segment, chained via dependsOn
app.post('/api/project/:id/generate', async (req, res) => {
  const { id } = req.params;
  const { clipId, prompt = '', seed, segIds, megapixels, retryOnFailure, autoRenderOnFinish = false, includeAudio = false, use2xUpscale = false, use2xFps = false } = req.body;

  try {
    const project = await loadProject(id);
    const clip    = project.sourceClips.find(c => c.id === clipId);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const clipFileNames = new Set(project.sourceClips.map(c => c.filename));
    const defaultRef = project.projectReferenceImage
      || project.assets.find(a => !clipFileNames.has(a) && /\.(png|jpe?g|webp|gif|avif)$/i.test(a))
      || null;
    if (!defaultRef) return res.status(400).json({ error: 'No reference image found — upload an image first' });

    const { mkdir } = await import('fs/promises');
    const outputDir = join(projectDir(id), 'generated');
    await mkdir(outputDir, { recursive: true });

    const resolvedSeed       = seed ?? (project.defaultSeed > 0 ? project.defaultSeed : Math.floor(Math.random() * 2 ** 32));
    const resolvedPrompt     = prompt || project.defaultPrompt || '';
    const resolvedMegapixels    = megapixels ?? project.megapixels ?? 0.5;
    const resolvedRetryOnFailure = retryOnFailure ?? project.retryOnFailure ?? false;
    const genFps         = project.useSourceFps ? (clip.fps || 24) : (project.genFps || 24);

    // Project segments are the canonical segmentation — one job per selected segment
    const allClipSegs = project.segments.filter(s => s.sourceClipId === clipId);
    const clipSegs = allClipSegs.filter(s =>
      segIds ? segIds.includes(s.id) : s.selected
    );
    console.log(`[generate] project=${id} segIds=${JSON.stringify(segIds)} allClipSegs=${allClipSegs.length} clipSegs=${clipSegs.length} → segments: ${clipSegs.map(s => s.id.slice(0,8)).join(', ')}`);

    let lastRef   = defaultRef;
    const jobs    = [];
    let prevJobId = null;   // next segment's dependency (for prevOutputLocalPath chain)
    let lastJobId = null;   // last queued job overall (for auto-render dependency)
    const batchId = `${id.slice(0, 6)}-${Date.now()}`;

    // If the first selected segment is mid-stream, resolve the previous segment's local output path.
    const firstSegmentIndex = clipSegs.length ? allClipSegs.indexOf(clipSegs[0]) : 0;
    let batchStartPrevOutputPath = null;
    if (firstSegmentIndex > 0) {
      const prevSeg = allClipSegs[firstSegmentIndex - 1];
      if (prevSeg?.generatedVideo) {
        batchStartPrevOutputPath = join(projectDir(id), 'generated', prevSeg.generatedVideo);
      }
    }

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
        useBaseWorkflow:        seg.useBaseWorkflow ?? false,
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
        megapixels:             resolvedMegapixels,
        retryOnFailure:         resolvedRetryOnFailure,
        outputPath,
        jobPrefix:              `motion-studio/${batchId}_seg${segmentIndex + 1}`,
        clipFps:                clip.fps,
        // For the first job in a mid-stream batch, supply the prior segment's local output path directly
        ...(i === 0 && batchStartPrevOutputPath && !(seg.useBaseWorkflow) ? { prevOutputLocalPath: batchStartPrevOutputPath } : {}),
      };

      const job = await enqueue(params, prevJobId);
      prevJobId = job.id;
      lastJobId = job.id;
      jobs.push(job);
      // Server-side hook: update segment when job completes (don't rely solely on browser SSE)
      subscribeJob(job.id, async updated => {
        if (updated.status === 'done') await syncJobToProject(updated).catch(() => {});
      });

      if (use2xUpscale) {
        const upscaledPath = outputPath.replace(/\.mp4$/i, '_2x.mp4');
        const esrganJob = await enqueue({
          jobType:      'esrgan-2x',
          projectId:    id,
          projectName:  project.name,
          segmentIndex,
          inputPath:    outputPath,
          outputPath:   upscaledPath,
          retryOnFailure: resolvedRetryOnFailure,
        }, job.id);
        lastJobId = esrganJob.id;
        jobs.push(esrganJob);
      }
    }

    if (autoRenderOnFinish && lastJobId) {
      const renderJob = await enqueue({
        jobType:        'auto-render',
        projectId:      id,
        projectName:    project.name,
        use2xUpscale,
        includeAudio,
        use2xFps,
        retryOnFailure: resolvedRetryOnFailure,
      }, lastJobId);
      jobs.push(renderJob);
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
  const { includeAudio = false, use2xFps = false } = req.body ?? {};
  try {
    const project  = await loadProject(id);
    const genSegs  = project.segments.filter(s => s.generatedVideo && s.selected !== false);
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
      // Auto-repair if clip was previously converted without audio (old bug)
      await repairClipAudio(audioSource).catch(() => {});
      await mixAudio(concatPath, audioSource, outPath);
      // clean up silent concat
      const { unlink } = await import('fs/promises');
      await unlink(concatPath).catch(() => {});
    } else {
      // rename concat → final (no audio mixing needed)
      const { rename } = await import('fs/promises');
      await rename(concatPath, outPath);
    }

    if (use2xFps) {
      const rife2xFile = `export_${stamp}_2x.mp4`;
      const rife2xPath = join(genDir, rife2xFile);
      const job = await enqueue({
        jobType:     'rife-2x',
        projectId:   id,
        projectName: project.name,
        inputPath:   outPath,
        outputPath:  rife2xPath,
        outputFile:  rife2xFile,
      });
      return res.json({
        rife2xPending: true,
        jobId:        job.id,
        job,
        basePath:     `/media/${id}/generated/${encodeURIComponent(outFile)}`,
        baseFilename: outFile,
      });
    }

    res.json({ path: `/media/${id}/generated/${encodeURIComponent(outFile)}`, filename: outFile });
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── List export files for a project ───────────────────────────
// POST /api/project/:id/upscale-segments
// Queues an ESRGAN 2x job for every done segment that doesn't already have a _2x file.
app.post('/api/project/:id/upscale-segments', async (req, res) => {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    const { stat } = await import('fs/promises');
    const genDir   = join(projectDir(id), 'generated');
    const done     = project.segments.filter(s => s.generatedVideo);
    const jobs     = [];

    for (let si = 0; si < done.length; si++) {
      const seg          = done[si];
      const origPath     = join(genDir, seg.generatedVideo);
      const upscaledPath = origPath.replace(/\.mp4$/i, '_2x.mp4');
      const alreadyDone  = await stat(upscaledPath).then(() => true).catch(() => false);
      if (alreadyDone) continue;
      const job = await enqueue({
        jobType:      'esrgan-2x',
        projectId:    id,
        projectName:  project.name,
        segmentIndex: project.segments.indexOf(seg),
        inputPath:    origPath,
        outputPath:   upscaledPath,
        retryOnFailure: project.retryOnFailure ?? false,
      });
      jobs.push(job);
    }

    res.json({ jobs, skipped: done.length - jobs.length });
  } catch (e) {
    console.error('Upscale segments error:', e);
    res.status(500).json({ error: e.message });
  }
});

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

app.get('/api/queue-status', (_req, res) => res.json({ paused: isQueuePaused() }));

app.post('/api/jobs/pause-all', async (req, res) => {
  const jobs = await pauseAllJobs();
  res.json({ paused: true, count: jobs.length });
});

app.post('/api/jobs/resume-all', async (req, res) => {
  const jobs = await resumeAllJobs();
  res.json({ paused: false, count: jobs.length });
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

// ── Asset browser ──────────────────────────────────────────────
const ASSET_ROOTS = {
  'video-references': '/mnt/windows/Others/LinuxFiles/resources_and_outputs/Video References',
  'clothes':          '/mnt/windows/Others/LinuxFiles/resources_and_outputs/Clothes',
  'comfyui':          `${process.env.HOME}/ComfyUI/output`,
};
const ASSET_ROOTS_LABELS = {
  'video-references': 'Video References',
  'clothes':          'Clothes',
  'comfyui':          'ComfyUI Output',
};
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.gif']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function _sanitizeSubpath(subpath) {
  if (!subpath) return '';
  // Strip leading slash, collapse .. segments
  return subpath.replace(/\.\./g, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

app.get('/api/asset-browser', async (req, res) => {
  const { root, subpath = '', sort = 'name', page = '1', perPage = '60' } = req.query;
  if (!ASSET_ROOTS[root]) {
    return res.json({ roots: Object.entries(ASSET_ROOTS_LABELS).map(([k, v]) => ({ key: k, label: v })) });
  }
  const safe = _sanitizeSubpath(subpath);
  const dir  = safe ? join(ASSET_ROOTS[root], safe) : ASSET_ROOTS[root];
  const pg   = Math.max(1, parseInt(page, 10) || 1);
  const pp   = Math.min(200, Math.max(1, parseInt(perPage, 10) || 60));
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs  = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const files = entries.filter(e => {
      if (!e.isFile()) return false;
      if (e.name.startsWith('._') || e.name.startsWith('.')) return false;
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      return VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext);
    }).map(e => e.name);
    const byDate = sort === 'date' || sort === 'date-asc';
    const sortedFiles = byDate
      ? await (async () => {
          const withStat = await Promise.all(files.map(async f => {
            try {
              const s = await stat(join(dir, f));
              // prefer birthtime (creation); fall back to mtime if birthtime is epoch (Linux ext4)
              const ts = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
              return { name: f, ts };
            }
            catch { return { name: f, ts: 0 }; }
          }));
          const cmp = sort === 'date-asc' ? (a, b) => a.ts - b.ts : (a, b) => b.ts - a.ts;
          return withStat.sort(cmp).map(x => x.name);
        })()
      : sort === 'name-desc'
        ? [...files].sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }))
        : [...files].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const total  = sortedFiles.length;
    const paged  = sortedFiles.slice((pg - 1) * pp, pg * pp);
    const items  = paged.map(name => {
      const ext     = name.slice(name.lastIndexOf('.')).toLowerCase();
      const isVideo = VIDEO_EXTS.has(ext);
      return { name, type: isVideo ? 'video' : 'image' };
    });
    res.json({ root, subpath: safe, dirs, items, total, page: pg, perPage: pp, totalPages: Math.ceil(total / pp) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/asset-browser-file — serve any asset file (image or video) for preview
app.get('/api/asset-browser-file', async (req, res) => {
  const { root, subpath = '', name } = req.query;
  if (!ASSET_ROOTS[root] || !name) return res.status(400).end();
  const safe     = _sanitizeSubpath(subpath);
  const safeName = basename(name);
  const dir      = safe ? join(ASSET_ROOTS[root], safe) : ASSET_ROOTS[root];
  const filePath = join(dir, safeName);
  const ext      = safeName.slice(safeName.lastIndexOf('.')).toLowerCase();
  if (!VIDEO_EXTS.has(ext) && !IMAGE_EXTS.has(ext)) return res.status(400).end();
  res.sendFile(filePath, { dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// POST /api/project/:id/import-from-server — copy a server asset into the project
app.post('/api/project/:id/import-from-server', async (req, res) => {
  const { id } = req.params;
  const { root, subpath = '', filename } = req.body ?? {};
  if (!ASSET_ROOTS[root] || !filename) return res.status(400).json({ error: 'Missing root or filename' });
  const safe     = _sanitizeSubpath(subpath);
  const safeName = basename(filename);
  const srcPath  = join(safe ? join(ASSET_ROOTS[root], safe) : ASSET_ROOTS[root], safeName);
  const ext      = safeName.slice(safeName.lastIndexOf('.')).toLowerCase();
  const isVideo  = VIDEO_EXTS.has(ext);
  try {
    const destDir  = uploadsDir(id);
    const destPath = join(destDir, safeName);

    const { copyFile, mkdir: mkdirFs } = await import('fs/promises');
    await mkdirFs(destDir, { recursive: true });
    await copyFile(srcPath, destPath);

    // Probe video outside the lock if needed
    let videoMeta = null;
    if (isVideo) videoMeta = await probeVideo(destPath);

    const updated = await withProjectLock(id, async () => {
      const proj = await loadProject(id);
      if (!proj) throw new Error('Project not found');
      if (!proj.assets.includes(safeName)) proj.assets.push(safeName);
      if (isVideo && videoMeta) {
        const alreadyClip = proj.sourceClips.some(c => c.filename === safeName);
        if (!alreadyClip) {
          const clipId = `clip-${randomUUID().slice(0, 8)}`;
          proj.sourceClips.push({ id: clipId, filename: safeName, fps: videoMeta.fps, totalFrames: videoMeta.totalFrames });
          if (proj.sourceClips.length === 1) proj.fps = videoMeta.fps;
        }
      }
      await saveProject(proj);
      return proj;
    });
    res.json({ project: updated, filename: safeName, isVideo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client-side routes (serve HTML shells) ─────────────────────
app.get('/projects/:id', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'index.html')));
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
    await withProjectLock(projectId, async () => {
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
    });
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

    await withProjectLock(projectId, async () => {
      const project  = await loadProject(projectId);
      const seg      = project.segments.find(s => s.id === segId);
      if (!seg) return;

      const filename = job.result.outputPath.split('/').pop();
      if (!project.generatedAssets) project.generatedAssets = [];

      const existing = project.generatedAssets.filter(a => a.segId === segId);
      const version  = existing.length;

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

      const jobTime    = new Date(job.completedAt ?? job.queuedAt ?? 0).getTime();
      const activeAsset = project.generatedAssets.find(a => a.filename === seg.generatedVideo);
      const activeTime = activeAsset ? new Date(activeAsset.createdAt ?? 0).getTime() : 0;
      if (jobTime >= activeTime) {
        seg.generatedVideo = filename;
      } else {
        console.log(`[server] syncJobToProject: skipping ${filename} — older than current active ${seg.generatedVideo}`);
        return;
      }

      await saveProject(project);
      console.log(`[server] synced ${filename} → ${segId} (v${version})`);
    });
  } catch { /* project may have been deleted */ }
}

app.listen(PORT, async () => {
  console.log(`Motion Studio → http://localhost:${PORT}`);

  // Global hook: sync every job completion to the project, regardless of when it was enqueued.
  // Covers resumed jobs whose per-job subscribeJob callbacks were lost on restart.
  subscribeAll(async updated => {
    if (updated.status !== 'done') return;
    if (updated.params?.jobType === 'qwen-edit') await syncQwenJobToProject(updated).catch(() => {});
    else await syncJobToProject(updated).catch(() => {});
  });

  resumeOnStartup().catch(e => console.error('[queue] resumeOnStartup error:', e));

  // Sync any segments whose jobs finished while server/browser was down (all days).
  // Runs in background so it doesn't delay the queue poller starting.
  (async () => {
    try {
      const jobs = await getAllDoneJobs();
      for (const job of jobs) {
        if (job.params?.jobType === 'qwen-edit') await syncQwenJobToProject(job);
        else await syncJobToProject(job);
      }
    } catch {}
  })();
});
