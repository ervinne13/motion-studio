import { readFile, rename, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { uploadImage, uploadVideo, queuePrompt, waitForResult, downloadOutput, checkPromptAlive } from './comfyui.js';
import { log } from './term.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS  = join(__dirname, '../workflows');

// WAN2.1 requires (n-1) % 4 == 0. Round up to the next valid count.
function snapFrameCount(n) {
  if (n <= 1) return 1;
  const rem = (n - 1) % 4;
  return rem === 0 ? n : n + (4 - rem);
}

// Find the minimum L >= minFrames such that (frameCount + L - 1) % 4 == 0.
// This guarantees frameCount + L is a valid WAN frame count with no snapping needed.
function computeCondFrames(frameCount, minFrames = 5) {
  const target = ((1 - frameCount) % 4 + 4) % 4;
  let L = target === 0 ? 4 : target;
  while (L < minFrames) L += 4;
  return L;
}

// Read frame count from container metadata — fast, no frame decoding.
function probeVideoFrameCount(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames',
      '-of', 'csv=p=0', videoPath,
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      const n = parseInt(out.trim(), 10);
      code === 0 && !isNaN(n) ? resolve(n) : reject(new Error(`ffprobe frame count failed for ${videoPath}`));
    });
  });
}

// Extract the last nFrames from a video using a known total frame count.
function ffmpegExtractTailFrames(inputPath, outputPath, totalFrames, nFrames) {
  return new Promise((resolve, reject) => {
    const startFrame = totalFrames - nFrames;
    const args = [
      '-y', '-i', inputPath,
      '-vf', `trim=start_frame=${startFrame},setpts=PTS-STARTPTS`,
      '-frames:v', String(nFrames),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-an',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg tail extract failed (${code})`)));
  });
}

async function loadWorkflow(name) {
  return JSON.parse(await readFile(join(WORKFLOWS, name), 'utf8'));
}

// VHS_VideoCombine stores results under 'gifs', not 'videos'
function firstVideoOutput(outputs) {
  for (const nodeOutputs of Object.values(outputs)) {
    if (nodeOutputs.gifs?.length)   return nodeOutputs.gifs[0];
    if (nodeOutputs.videos?.length) return nodeOutputs.videos[0];
  }
  throw new Error('No video output found in ComfyUI result');
}

function resolveMegapixels(megapixels) {
  const n = parseFloat(megapixels);
  return isNaN(n) ? 0.5 : n;
}

function buildBase(wf, { imageFilename, videoFilename, fps, frameCount, startFrame, prompt, seed, prefix, replacementMode, megapixels }) {
  const w = structuredClone(wf);
  w['58'].inputs.image                           = imageFilename;
  w['113'].inputs.video                          = videoFilename;
  w['135'].inputs.value                          = fps;
  w['137'].inputs.text                           = prompt;
  w['139'].inputs.seed                           = seed;
  w['140'].inputs.value                          = snapFrameCount(frameCount);
  w['141'].inputs.value                          = startFrame;
  w['49'].inputs.filename_prefix                 = prefix;
  w['138:101'].inputs.replacement_mode           = replacementMode;
  w['138:107'].inputs.replacement_mode           = replacementMode;
  w['138:102'].inputs['resize_type.megapixels']  = resolveMegapixels(megapixels);
  return w;
}

function buildExtend(wf, { imageFilename, videoFilename, fps, frameCount, startFrame, prompt, seed, prefix, prevVideoFile, condFrames, replacementMode, megapixels }) {
  const w = structuredClone(wf);
  w['211'].inputs.image                          = imageFilename;
  w['210'].inputs.video                          = videoFilename;
  w['201'].inputs.value                          = fps;
  w['202'].inputs.text                           = prompt;
  w['208'].inputs.seed                           = seed;
  // frameCount + condFrames is guaranteed valid (4n+1) by computeCondFrames — no snap needed.
  // After generation, condFrames prepended conditioning frames are trimmed, leaving exactly frameCount.
  w['228'].inputs.value                          = frameCount + condFrames;
  // Load source condFrames earlier so conditioning frames align with source motion,
  // and new content begins exactly at the segment boundary after trim.
  w['229'].inputs.value                          = Math.max(0, startFrame - condFrames);
  w['225'].inputs.file                           = prevVideoFile;
  w['207'].inputs.filename_prefix                = prefix;
  w['209:101'].inputs.previous_frame_count       = condFrames;
  w['209:101'].inputs.replacement_mode           = replacementMode;
  w['209:107'].inputs.replacement_mode           = replacementMode;
  w['209:102'].inputs['resize_type.megapixels']  = resolveMegapixels(megapixels);
  return w;
}

function ffmpegExtract(inputPath, outputPath, startSec, durSec) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-ss', String(startSec), '-t', String(durSec),
      '-i', inputPath,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-an',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg extract failed (${code})`)));
  });
}

function ffmpegConcat(segPaths, outputPath) {
  return new Promise((resolve, reject) => {
    // Build filter: seg0 as-is, seg1+ trim first 5 frames
    const filterParts = segPaths.map((_, i) =>
      i === 0
        ? `[${i}:v]setpts=PTS-STARTPTS[v${i}]`
        : `[${i}:v]trim=start_frame=5,setpts=PTS-STARTPTS[v${i}]`
    );
    const concatIn  = segPaths.map((_, i) => `[v${i}]`).join('');
    const filter    = [
      ...filterParts,
      `${concatIn}concat=n=${segPaths.length}:v=1:a=0[out]`,
    ].join(';');

    const inputs = segPaths.flatMap(p => ['-i', p]);
    const args   = [
      '-y', ...inputs,
      '-filter_complex', filter,
      '-map', '[out]',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args);
    proc.on('close', code => code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg concat failed (${code})`)));
  });
}

// Trim the first N frames from a video using an exact frame-accurate filter.
function ffmpegTrimFrames(inputPath, outputPath, skipFrames) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', inputPath,
      '-vf', `trim=start_frame=${skipFrames},setpts=PTS-STARTPTS`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-an',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg trim failed (${code})`)));
  });
}

/**
 * Generate a single segment and return paths for the next segment to use.
 *
 * @param {object} opts
 * @param {number}  opts.segmentIndex        - 0 = base workflow, 1+ = extend workflow
 * @param {string}  opts.motionVideoPath     - local path to motion reference video
 * @param {string}  opts.referenceImagePath  - local path to reference image for this segment
 * @param {number}  opts.genFps
 * @param {number}  opts.frameCount          - gen frames for this segment
 * @param {number}  opts.startFrame          - start frame in motion video
 * @param {string}  opts.prompt
 * @param {number}  opts.seed
 * @param {string}  opts.outputPath          - full local path for the output .mp4
 * @param {string}  opts.jobPrefix           - ComfyUI filename prefix
 * @param {string}  [opts.prevOutputLocalPath] - local path to previous segment output (extend only)
 * @param {function} [opts.onProgress]
 * @returns {Promise<{ outputPath: string, prevOutputLocalPath: string }>}
 */
export async function generateSegment({
  segmentIndex,
  useBaseWorkflow    = false,
  motionVideoPath,
  referenceImagePath,
  genFps,
  frameCount,
  startFrame,
  clipFps            = 30,
  prompt             = '',
  seed               = Math.floor(Math.random() * 2 ** 32),
  mode               = 'subject-replacement',
  outputPath,
  jobPrefix,
  prevOutputLocalPath = null,
  megapixels          = 0.5,
  existingPromptId   = null,
  onProgress         = () => {},
  onQueued           = () => {},
}) {
  // ── Mock mode: extract source segment instead of running ComfyUI ──
  if (process.env.MOCK_GENERATE === 'true') {
    const { mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    await mkdir(dirname(outputPath), { recursive: true });
    onProgress(0, 1, 'extracting');
    const startSec = startFrame / clipFps;
    const durSec   = frameCount / genFps;
    await ffmpegExtract(motionVideoPath, outputPath, startSec, durSec);
    onProgress(1, 1, 'done');
    return { outputPath, comfyInputFilename: `mock-${outputPath.split('/').pop()}` };
  }

  const [baseWF, extendWF] = await Promise.all([
    loadWorkflow('scail-base-motion.api.json'),
    loadWorkflow('scail-extended-motion.api.json'),
  ]);

  onProgress(0, 1, 'uploading');
  const [videoFilename, imageFilename] = await Promise.all([
    uploadVideo(motionVideoPath),
    uploadImage(referenceImagePath),
  ]);

  onProgress(0, 1, 'generating');

  const replacementMode = mode === 'subject-replacement';
  let workflow;
  const isBase = segmentIndex === 0 || useBaseWorkflow;
  if (isBase) {
    workflow = buildBase(baseWF, {
      imageFilename, videoFilename, fps: genFps,
      frameCount, startFrame, prompt, seed, prefix: jobPrefix, replacementMode, megapixels,
    });
  } else {
    if (!prevOutputLocalPath) throw new Error('prevOutputLocalPath required for extend segment');
    const condFrames = computeCondFrames(frameCount);
    const condTailPath = outputPath + '.condtail.mp4';
    const totalPrevFrames = await probeVideoFrameCount(prevOutputLocalPath);
    await ffmpegExtractTailFrames(prevOutputLocalPath, condTailPath, totalPrevFrames, condFrames);
    const condVideoFilename = await uploadVideo(condTailPath);
    await unlink(condTailPath);
    workflow = buildExtend(extendWF, {
      imageFilename, videoFilename, fps: genFps,
      frameCount, startFrame, prompt, seed, prefix: jobPrefix,
      prevVideoFile: condVideoFilename, condFrames, replacementMode, megapixels,
    });
  }

  let promptId = existingPromptId && await checkPromptAlive(existingPromptId) ? existingPromptId : null;
  if (promptId) {
    log(`[generate] re-attaching to existing ComfyUI prompt ${promptId} (server restart recovery)`);
  } else {
    promptId = await queuePrompt(workflow);
    await onQueued(promptId, workflow);
  }
  const outputs  = await waitForResult(promptId);
  const vid      = firstVideoOutput(outputs);

  await downloadOutput(vid.filename, vid.subfolder, outputPath);

  if (!isBase) {
    // Trim the prepended conditioning frames so the stored file contains exactly frameCount frames.
    const condFrames = computeCondFrames(frameCount);
    const trimmedPath = outputPath + '.trimtmp.mp4';
    await ffmpegTrimFrames(outputPath, trimmedPath, condFrames);
    await unlink(outputPath);
    await rename(trimmedPath, outputPath);
  }

  onProgress(1, 1, 'done');
  // Return the local output path so the next extend segment can extract its conditioning tail.
  return { outputPath, prevOutputLocalPath: outputPath };
}

// ── Qwen image edit ────────────────────────────────────────────

function firstImageOutput(outputs) {
  for (const nodeOutputs of Object.values(outputs)) {
    if (nodeOutputs.images?.length) return nodeOutputs.images[0];
  }
  throw new Error('No image output found in ComfyUI result');
}

function ffmpegExtractFrame(videoPath, outputPng, frameIndex) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', videoPath,
      '-vf', `select='eq(n\\,${frameIndex})'`,
      '-frames:v', '1',
      '-vsync', '0',
      outputPng,
    ];
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? resolve(outputPng) : reject(new Error(`ffmpeg frame extract failed (${code})`)));
  });
}

function buildQwenRegular(wf, { frameFilename, supportFilename, prompt, prefix }) {
  const w = structuredClone(wf);
  w['41'].inputs.image           = frameFilename;
  w['172'].inputs.image          = supportFilename;
  w['170:149'].inputs.prompt     = prompt;
  w['9'].inputs.filename_prefix  = prefix;
  return w;
}

function buildQwenNsfw(wf, { frameFilename, prompt, prefix }) {
  const w = structuredClone(wf);
  w['16'].inputs.image           = frameFilename;
  w['1'].inputs.string_b         = prompt;
  w['6'].inputs.filename_prefix  = prefix;
  return w;
}

export async function generateEsrgan2x({ inputVideoPath, outputPath, existingPromptId = null, onQueued = () => {} }) {
  const wf = await loadWorkflow('real-esrgan-2x-upscale-video.api.json');
  const w = structuredClone(wf);
  const videoFilename = await uploadVideo(inputVideoPath);
  w['2'].inputs.file = videoFilename;
  w['7'].inputs.filename_prefix = `motion-studio/esrgan-${Date.now()}`;
  let promptId = existingPromptId && await checkPromptAlive(existingPromptId) ? existingPromptId : null;
  if (promptId) {
    log(`[generate] re-attaching to existing ComfyUI prompt ${promptId} (server restart recovery)`);
  } else {
    promptId = await queuePrompt(w);
    await onQueued(promptId, w);
  }
  const outputs = await waitForResult(promptId);
  const vid = firstVideoOutput(outputs);
  await downloadOutput(vid.filename, vid.subfolder, outputPath);
  return outputPath;
}

export async function generateRife2x({ inputVideoPath, outputPath, existingPromptId = null, onQueued = () => {} }) {
  const wf = await loadWorkflow('interpolate-frames-rife2x.api.json');
  const w = structuredClone(wf);
  const videoFilename = await uploadVideo(inputVideoPath);
  w['6'].inputs.file = videoFilename;
  let promptId = existingPromptId && await checkPromptAlive(existingPromptId) ? existingPromptId : null;
  if (promptId) {
    log(`[generate] re-attaching to existing ComfyUI prompt ${promptId} (server restart recovery)`);
  } else {
    promptId = await queuePrompt(w);
    await onQueued(promptId, w);
  }
  const outputs = await waitForResult(promptId);
  const vid = firstVideoOutput(outputs);
  await downloadOutput(vid.filename, vid.subfolder, outputPath);
  return outputPath;
}

export async function generateQwenEdit({ videoPath, frameIndex, prompt, supportImagePath, nsfw, outputPath, prefix, existingPromptId = null, onQueued = () => {} }) {
  const tmpFrame = join(dirname(outputPath), `_frame_${Date.now()}.png`);
  try {
    await ffmpegExtractFrame(videoPath, tmpFrame, frameIndex);
    const frameFilename = await uploadImage(tmpFrame);

    let workflow;
    if (nsfw) {
      const wf = await loadWorkflow('qwen-image-edit-nsfw.api.json');
      workflow = buildQwenNsfw(wf, { frameFilename, prompt: prompt || '', prefix });
    } else {
      const wf = await loadWorkflow('qwen-image-edit.api.json');
      const supportFilename = supportImagePath ? await uploadImage(supportImagePath) : frameFilename;
      workflow = buildQwenRegular(wf, { frameFilename, supportFilename, prompt: prompt || '', prefix });
    }

    let promptId = existingPromptId && await checkPromptAlive(existingPromptId) ? existingPromptId : null;
    if (promptId) {
      log(`[generate] re-attaching to existing ComfyUI prompt ${promptId} (server restart recovery)`);
    } else {
      promptId = await queuePrompt(workflow);
      await onQueued(promptId, workflow);
    }
    const outputs  = await waitForResult(promptId);
    const img      = firstImageOutput(outputs);
    await downloadOutput(img.filename, img.subfolder, outputPath);
    return outputPath;
  } finally {
    unlink(tmpFrame).catch(() => {});
  }
}
