import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

function dataDir() {
  return process.env.DATA_DIR || './data';
}

export function projectDir(id)  { return join(dataDir(), 'projects', id); }
export function uploadsDir(id)  { return join(projectDir(id), 'uploads'); }
export function thumbsDir(id)   { return join(projectDir(id), 'thumbs'); }
function projectFile(id)        { return join(projectDir(id), 'project.json'); }

// Segment boundaries are derived from gen-frame settings.
// Source frames per segment = genFramesPerSegment / genFps * clipFps
export function computeSegments(clipId, totalFrames, clipFps, genFps, genFramesPerSegment) {
  const segSec      = genFramesPerSegment / genFps;
  const segSrcFrames = Math.round(segSec * clipFps);
  const count       = Math.ceil(totalFrames / segSrcFrames);
  return Array.from({ length: count }, (_, i) => ({
    id:             `seg-${randomUUID().slice(0, 8)}`,
    sourceClipId:   clipId,
    startFrame:     i * segSrcFrames,
    frameCount:     Math.min(segSrcFrames, totalFrames - i * segSrcFrames),
    referenceImage: null,
    prompt:         null,
    generatedVideo: null,
    visible:        true,
    selected:       true,
  }));
}

export async function createProject() {
  const id = randomUUID().slice(0, 8);
  await mkdir(uploadsDir(id), { recursive: true });
  await mkdir(thumbsDir(id),  { recursive: true });

  const project = {
    id,
    name: 'untitled',
    mode: 'subject-replacement',
    fps: 24,
    aspectRatio: '9:16',
    defaultPrompt: '',
    defaultSeed: -1,
    genFps: 24,
    genFramesPerSegment: 81,
    projectReferenceImage: null,
    sourceClips: [],
    assets: [],
    segments: [],
    frameEdits: {},
  };

  await writeFile(projectFile(id), JSON.stringify(project, null, 2));
  return project;
}

export async function loadProject(id) {
  const raw = await readFile(projectFile(id), 'utf8');
  return JSON.parse(raw);
}

export async function saveProject(project) {
  await writeFile(projectFile(project.id), JSON.stringify(project, null, 2));
}
