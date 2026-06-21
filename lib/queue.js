import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { generateSegment } from './generate.js';

const DATA_DIR  = process.env.DATA_DIR    || './data';
const COMFYUI   = process.env.COMFYUI_SERVER || 'http://192.168.0.110:8188';
const QUEUE_DIR = join(DATA_DIR, 'queue');
const POLL_MS   = 5000;

let _pollTimer       = null;
let _processingJobId = null;
const _listeners     = new Map(); // jobId → Set<(job) => void>

// ── File helpers ───────────────────────────────────────────────

function todayFile() {
  return join(QUEUE_DIR, `${new Date().toISOString().slice(0, 10)}.json`);
}

async function readLogFile(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch { return []; }
}

async function writeLogFile(filePath, jobs) {
  await mkdir(QUEUE_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(jobs, null, 2));
}

// Returns [filePath, jobs] pairs, newest first, across all log files
async function allLogFiles() {
  try {
    const files = (await readdir(QUEUE_DIR))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    const pairs = [];
    for (const f of files) {
      const fp   = join(QUEUE_DIR, f);
      const jobs = await readLogFile(fp);
      pairs.push([fp, jobs]);
    }
    return pairs;
  } catch {
    return [];
  }
}

async function findJob(jobId) {
  for (const [fp, jobs] of await allLogFiles()) {
    const hit = jobs.find(j => j.id === jobId);
    if (hit) return { job: hit, filePath: fp, jobs };
  }
  return null;
}

async function patchJob(jobId, updates) {
  const found = await findJob(jobId);
  if (!found) return null;
  const { filePath, jobs } = found;
  const idx = jobs.findIndex(j => j.id === jobId);
  Object.assign(jobs[idx], updates);
  await writeLogFile(filePath, jobs);
  for (const cb of (_listeners.get(jobId) ?? [])) cb(jobs[idx]);
  return jobs[idx];
}

// ── Eligibility check ──────────────────────────────────────────

// Returns the next pending job that is ready to run (dependency resolved),
// cascading failure on blocked jobs whose dependency failed.
async function nextEligible() {
  // Scan oldest-first so we drain in creation order
  const pairs = (await allLogFiles()).reverse(); // oldest first
  for (const [fp, jobs] of pairs) {
    for (const job of jobs) {
      if (job.status !== 'pending') continue;

      if (!job.dependsOn) return job; // no dependency → ready

      // Check dependency status
      const depFound = await findJob(job.dependsOn);
      const dep = depFound?.job;

      if (!dep || dep.status === 'failed') {
        // Cascade failure
        const idx = jobs.findIndex(j => j.id === job.id);
        Object.assign(jobs[idx], {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: 'Dependency failed',
        });
        await writeLogFile(fp, jobs);
        for (const cb of (_listeners.get(job.id) ?? [])) cb(jobs[idx]);
        continue;
      }

      if (dep.status === 'done') return job; // dependency done → ready
      // dep is pending or running → skip, wait
    }
  }
  return null;
}

// ── ComfyUI availability ───────────────────────────────────────

async function isComfyUIFree() {
  if (process.env.MOCK_GENERATE === 'true') return true;
  try {
    const res  = await fetch(`${COMFYUI}/queue`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    return data.queue_running.length === 0 && data.queue_pending.length === 0;
  } catch {
    return false;
  }
}

// ── Poller ─────────────────────────────────────────────────────

async function tick() {
  if (_processingJobId) return;

  const job = await nextEligible();
  if (!job) { stopPoller(); return; }

  const free = await isComfyUIFree();
  if (!free) return;

  _processingJobId = job.id;
  await patchJob(job.id, { status: 'running', startedAt: new Date().toISOString() });

  try {
    // Resolve prevComfyFilename from dependency result
    let prevComfyFilename = null;
    if (job.dependsOn) {
      const depFound = await findJob(job.dependsOn);
      prevComfyFilename = depFound?.job?.result?.comfyInputFilename ?? null;
    }

    const result = await generateSegment({
      ...job.params,
      prevComfyFilename,
      onProgress: async (done, total, phase) => {
        await patchJob(job.id, { progress: { done, total, phase } });
      },
    });

    await patchJob(job.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      result,
      progress: null,
    });
  } catch (err) {
    await patchJob(job.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err.message,
      progress: null,
    });
  } finally {
    _processingJobId = null;
    // Trigger next job immediately rather than waiting for the 5s interval
    setTimeout(tick, 300);
  }
}

function startPoller() {
  if (_pollTimer) return;
  tick();
  _pollTimer = setInterval(tick, POLL_MS);
}

function stopPoller() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ── Public API ─────────────────────────────────────────────────

export async function enqueue(params, dependsOn = null) {
  const filePath = todayFile();
  const jobs = await readLogFile(filePath);
  const job = {
    id:          `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    dependsOn,
    status:      'pending',
    queuedAt:    new Date().toISOString(),
    startedAt:   null,
    completedAt: null,
    progress:    null,
    params,
    result:      null,
    error:       null,
  };
  jobs.push(job);
  await writeLogFile(filePath, jobs);
  startPoller();
  return job;
}

export async function getJob(jobId) {
  const found = await findJob(jobId);
  return found?.job ?? null;
}

// Returns all jobs from today's log file (newest-first within file order preserved)
export async function getTodayJobs() {
  return await readLogFile(todayFile());
}

export function subscribeJob(jobId, callback) {
  if (!_listeners.has(jobId)) _listeners.set(jobId, new Set());
  _listeners.get(jobId).add(callback);
  return () => _listeners.get(jobId)?.delete(callback);
}

export async function resumeOnStartup() {
  const job = await nextEligible();
  if (job) {
    console.log(`[queue] Resuming: found pending job ${job.id}`);
    startPoller();
  }
}
