import { readFile, writeFile, rename, mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSegment } from './generate.js';
import { log, inlineLog } from './term.js';

const DATA_DIR  = process.env.DATA_DIR    || './data';
const COMFYUI   = process.env.COMFYUI_SERVER || 'http://192.168.0.110:8188';
const QUEUE_DIR = join(DATA_DIR, 'queue');
const POLL_MS   = 5000;

let _pollTimer       = null;
let _processingJobId = null;
const _listeners     = new Map(); // jobId → Set<(job) => void>
const _globalListeners = new Set(); // fires for every job update

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
  const tmp = join(tmpdir(), `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(tmp, JSON.stringify(jobs, null, 2));
  await rename(tmp, filePath);
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
  for (const cb of _globalListeners) cb(jobs[idx]);
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
      if (job.status !== 'pending' && job.status !== 'waiting') continue;

      if (!job.dependsOn) return job; // no dependency → ready

      // Check dependency status
      const depFound = await findJob(job.dependsOn);
      const dep = depFound?.job;

      if (!dep || dep.status === 'failed' || dep.status === 'cancelled') {
        // Cascade failure/cancellation
        const cascade = dep?.status === 'cancelled' ? 'cancelled' : 'failed';
        const idx = jobs.findIndex(j => j.id === job.id);
        Object.assign(jobs[idx], {
          status: cascade,
          completedAt: new Date().toISOString(),
          error: cascade === 'failed' ? 'Dependency failed' : null,
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

async function checkComfyUI() {
  if (process.env.MOCK_GENERATE === 'true') return { free: true, running: 0, pending: 0 };
  try {
    const res  = await fetch(`${COMFYUI}/queue`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const running = data.queue_running.length;
    const pending = data.queue_pending.length;
    return { free: running === 0 && pending === 0, running, pending };
  } catch (err) {
    return { free: false, running: -1, pending: -1, error: err.message };
  }
}

// ── Poller ─────────────────────────────────────────────────────

let _waitCheckCount = 0;

async function tick() {
  if (_processingJobId) return;

  const job = await nextEligible();
  if (!job) {
    if (_waitCheckCount > 0) log('');  // flush any inline line
    log('[queue] no eligible jobs, stopping poller');
    _waitCheckCount = 0;
    stopPoller();
    return;
  }

  const { free, running, pending, error } = await checkComfyUI();
  if (!free) {
    _waitCheckCount++;
    const detail = error
      ? `unreachable (${error})`
      : `ComfyUI busy — running=${running} pending=${pending}`;
    inlineLog(`[queue] waiting for seg ${job.params?.segmentIndex} · check #${_waitCheckCount} · ${detail}`);
    // Mark as 'waiting' only on first discovery (avoid repeated disk writes)
    if (job.status === 'pending') {
      await patchJob(job.id, { status: 'waiting' });
    }
    return;
  }

  if (_waitCheckCount > 0) {
    log(`[queue] ComfyUI free after ${_waitCheckCount} check(s)`);
    _waitCheckCount = 0;
  }

  _processingJobId = job.id;
  await patchJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
  log(`[queue] starting seg ${job.params?.segmentIndex} (${job.id})`);

  try {
    // Resolve prevComfyFilename: dependency result takes priority, params fallback for mid-stream batches
    let prevComfyFilename = job.params.prevComfyFilename ?? null;
    if (job.dependsOn) {
      const depFound = await findJob(job.dependsOn);
      prevComfyFilename = depFound?.job?.result?.comfyInputFilename ?? prevComfyFilename;
      log(`[queue] job ${job.id} depends on ${job.dependsOn}, prevComfyFilename=${prevComfyFilename}`);
    }

    const result = await generateSegment({
      ...job.params,
      prevComfyFilename,
      onProgress: async (done, total, phase) => {
        log(`[queue] job ${job.id} progress: ${phase} (${done}/${total})`);
        await patchJob(job.id, { progress: { done, total, phase } });
      },
    });

    // Don't overwrite if job was cancelled while running
    const current = await findJob(job.id);
    if (current?.job?.status === 'cancelled') {
      log(`[queue] job ${job.id} was cancelled, ignoring result`);
    } else {
      log(`[queue] job ${job.id} done, output=${result.outputPath}`);
      await patchJob(job.id, {
        status: 'done',
        completedAt: new Date().toISOString(),
        result,
        progress: null,
      });
    }
  } catch (err) {
    const current = await findJob(job.id);
    if (current?.job?.status !== 'cancelled') {
      log(`[queue] job ${job.id} failed: ${err.message}`);
      await patchJob(job.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err.message,
        progress: null,
      });
    }
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

export async function cancelJob(jobId) {
  const found = await findJob(jobId);
  if (!found) return null;
  const { job } = found;
  if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
  log(`[queue] cancelling job ${jobId} (was ${job.status})`);
  return patchJob(jobId, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    progress: null,
  });
}

// Returns jobs from today's file, falling back to the most recent non-empty file
export async function getTodayJobs() {
  const today = await readLogFile(todayFile());
  if (today.length > 0) return today;
  // Fall back to most recent file that has jobs
  for (const [, jobs] of await allLogFiles()) {
    if (jobs.length > 0) return jobs;
  }
  return [];
}

export function subscribeAll(callback) {
  _globalListeners.add(callback);
  return () => _globalListeners.delete(callback);
}

export function subscribeJob(jobId, callback) {
  if (!_listeners.has(jobId)) _listeners.set(jobId, new Set());
  _listeners.get(jobId).add(callback);
  return () => _listeners.get(jobId)?.delete(callback);
}

export async function resumeOnStartup() {
  // Reset any jobs left in "running" state from a previous crashed server
  const pairs = await allLogFiles();
  let resetCount = 0;
  for (const [fp, jobs] of pairs) {
    let dirty = false;
    for (const job of jobs) {
      if (job.status === 'running' || job.status === 'waiting') {
        log(`[queue] startup: resetting orphaned ${job.status} job ${job.id} → pending`);
        job.status = 'pending';
        job.startedAt = null;
        job.progress = null;
        dirty = true;
        resetCount++;
      }
    }
    if (dirty) await writeLogFile(fp, jobs);
  }
  if (resetCount > 0) log(`[queue] startup: reset ${resetCount} orphaned job(s)`);

  const job = await nextEligible();
  if (job) {
    log(`[queue] startup: found pending job ${job.id}, starting poller`);
    startPoller();
  } else {
    log('[queue] startup: no pending jobs');
  }
}
