import { readFile, writeFile, rename, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { generateSegment, generateQwenEdit } from './generate.js';
import { log, inlineLog } from './term.js';

const DATA_DIR  = process.env.DATA_DIR    || './data';
const COMFYUI   = process.env.COMFYUI_SERVER || 'http://127.0.0.1:8188';
const QUEUE_DIR = join(DATA_DIR, 'queue');
const POLL_MS   = 5000;

let _pollTimer       = null;
let _processingJobId = null;
const _listeners     = new Map(); // jobId → Set<(job) => void>
const _globalListeners = new Set(); // fires for every job update

// ── Queue file mutex ───────────────────────────────────────────
// Serialises all read-modify-write operations on queue log files.
// Without this, concurrent enqueue + patchJob writes lose each other's data.
let _queueLockChain = Promise.resolve();
function withQueueLock(fn) {
  const next = _queueLockChain.then(fn);
  // Swallow errors so a failed fn doesn't break the chain for subsequent callers
  _queueLockChain = next.catch(() => {});
  return next;
}

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
  const tmp = join(QUEUE_DIR, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(tmp, JSON.stringify(jobs, null, 2));
  await rename(tmp, filePath);
}

// Returns [filePath, jobs] pairs, newest first, across all log files
async function allLogFiles() {
  try {
    const files = (await readdir(QUEUE_DIR))
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
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
  let notifyJob = null;
  await withQueueLock(async () => {
    const found = await findJob(jobId);
    if (!found) return;
    const { filePath, jobs } = found;
    const idx = jobs.findIndex(j => j.id === jobId);
    Object.assign(jobs[idx], updates);
    await writeLogFile(filePath, jobs);
    notifyJob = jobs[idx];
  });
  if (!notifyJob) return null;
  for (const cb of (_listeners.get(jobId) ?? [])) cb(notifyJob);
  for (const cb of _globalListeners) cb(notifyJob);
  return notifyJob;
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

      if (!dep || dep.status === 'failed') {
        // Only cascade-fail on hard failure, not cancellation — cancelled deps may be retried
        await patchJob(job.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: 'Dependency failed',
        });
        continue;
      }

      if (dep.status === 'cancelled') {
        // Leave waiting — user may retry the cancelled dep; don't kill the chain
        continue;
      }

      if (dep.status === 'done') return job; // dependency done → ready
      // dep is pending/waiting/running → skip, wait
    }
  }
  return null;
}

// ── ComfyUI availability ───────────────────────────────────────

async function checkComfyUI() {
  if (process.env.MOCK_GENERATE === 'true') return { free: true, running: 0, pending: 0, runningPromptIds: [] };
  try {
    const res  = await fetch(`${COMFYUI}/queue`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const running = data.queue_running.length;
    const pending = data.queue_pending.length;
    // queue_running entries are [number, promptId, workflow, ...]
    const runningPromptIds = (data.queue_running ?? []).map(e => e[1]).filter(Boolean);
    return { free: running === 0 && pending === 0, running, pending, runningPromptIds };
  } catch (err) {
    return { free: false, running: -1, pending: -1, runningPromptIds: [], error: err.message };
  }
}

// If ComfyUI is running a prompt that belongs to one of our reset jobs, interrupt it.
async function maybeInterruptZombie(runningPromptIds) {
  if (!runningPromptIds.length) return;
  for (const [, jobs] of await allLogFiles()) {
    for (const job of jobs) {
      if (!job.comfyPromptId) continue;
      if (!runningPromptIds.includes(job.comfyPromptId)) continue;
      // Only interrupt if we no longer consider this job as running (it got reset on restart)
      if (!['pending', 'waiting', 'failed', 'cancelled'].includes(job.status)) continue;
      log(`[queue] zombie detected: ComfyUI running our old prompt ${job.comfyPromptId} (job ${job.id}, status=${job.status}) — interrupting`);
      try {
        await fetch(`${COMFYUI}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(4000) });
        log(`[queue] zombie interrupted`);
      } catch (err) {
        log(`[queue] zombie interrupt failed: ${err.message}`);
      }
      return; // one interrupt is enough
    }
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

  const { free, running, pending, runningPromptIds, error } = await checkComfyUI();
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
    // Safe zombie interrupt: only if the running ComfyUI prompt is one WE submitted
    if (running > 0) await maybeInterruptZombie(runningPromptIds);
    return;
  }

  if (_waitCheckCount > 0) {
    log(`[queue] ComfyUI free after ${_waitCheckCount} check(s)`);
    _waitCheckCount = 0;
  }

  _processingJobId = job.id;
  await patchJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
  log(`[queue] starting ${job.params?.jobType ?? 'segment'} job (${job.id})`);

  // Watchdog: if ComfyUI goes idle while job is still "running" after 15 min, self-heal
  const WATCHDOG_MS   = 15 * 60 * 1000;
  const WATCHDOG_INTERVAL = 60 * 1000;
  const watchdogStart = Date.now();
  const watchdog = setInterval(async () => {
    if (_processingJobId !== job.id) { clearInterval(watchdog); return; }
    if (Date.now() - watchdogStart < WATCHDOG_MS) return;
    try {
      const res  = await fetch(`${COMFYUI}/queue`);
      const data = await res.json();
      const queueRunning = (data.queue_running ?? []).length;
      const queuePending = (data.queue_pending ?? []).length;
      if (queueRunning === 0 && queuePending === 0) {
        log(`[queue] watchdog: ComfyUI idle but job ${job.id} still running — marking failed and releasing`);
        clearInterval(watchdog);
        const cur = await findJob(job.id);
        if (cur?.job?.status === 'running') {
          await patchJob(job.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: 'ComfyUI went idle — job timed out (watchdog)',
            progress: null,
          });
        }
        _processingJobId = null;
        setTimeout(tick, 300);
      }
    } catch { /* ComfyUI unreachable — leave to normal timeout */ }
  }, WATCHDOG_INTERVAL);

  try {
    let result;
    const onQueued = async (promptId, workflow) => {
      log(`[queue] job ${job.id} submitted to ComfyUI as prompt ${promptId}`);
      await patchJob(job.id, { comfyPromptId: promptId, comfyWorkflow: workflow ?? null });
    };

    if (job.params?.jobType === 'qwen-edit') {
      result = await generateQwenEdit({ ...job.params, onQueued, existingPromptId: job.comfyPromptId ?? null });
    } else {
      // Resolve prevComfyFilename: dependency result takes priority, params fallback for mid-stream batches
      let prevComfyFilename = job.params.prevComfyFilename ?? null;
      if (job.dependsOn) {
        const depFound = await findJob(job.dependsOn);
        prevComfyFilename = depFound?.job?.result?.comfyInputFilename ?? prevComfyFilename;
        log(`[queue] job ${job.id} depends on ${job.dependsOn}, prevComfyFilename=${prevComfyFilename}`);
      }

      result = await generateSegment({
        ...job.params,
        prevComfyFilename,
        onQueued,
        existingPromptId: job.comfyPromptId ?? null,
        onProgress: async (done, total, phase) => {
          log(`[queue] job ${job.id} progress: ${phase} (${done}/${total})`);
          await patchJob(job.id, { progress: { done, total, phase } });
        },
      });
    }

    // Don't overwrite if job was cancelled while running
    const current = await findJob(job.id);
    if (current?.job?.status === 'cancelled') {
      log(`[queue] job ${job.id} was cancelled, ignoring result`);
    } else {
      const outputPath = result?.outputPath ?? result;
      log(`[queue] job ${job.id} done, output=${outputPath}`);
      await patchJob(job.id, {
        status: 'done',
        completedAt: new Date().toISOString(),
        result: typeof result === 'string' ? { outputPath: result } : result,
        progress: null,
      });
    }
  } catch (err) {
    const current = await findJob(job.id);
    if (!['cancelled', 'done'].includes(current?.job?.status)) {
      const isTransient = /timed out|fetch failed|ECONNREFUSED|ECONNRESET|network|restarted.*prompt lost/i.test(err.message);
      const autoRetries = job.params?._autoRetries ?? 0;
      if (isTransient && autoRetries < 3) {
        log(`[queue] job ${job.id} transient failure (${err.message}), auto-retry ${autoRetries + 1}/3`);
        await patchJob(job.id, {
          status: 'pending',
          startedAt: null,
          progress: null,
          error: null,
          params: { ...job.params, _autoRetries: autoRetries + 1 },
        });
      } else {
        log(`[queue] job ${job.id} failed: ${err.message}`);
        await patchJob(job.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: err.message,
          progress: null,
        });
      }
    }
  } finally {
    clearInterval(watchdog);
    _processingJobId = null;
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
  await withQueueLock(async () => {
    const filePath = todayFile();
    const jobs = await readLogFile(filePath);
    jobs.push(job);
    await writeLogFile(filePath, jobs);
  });
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

// Forcibly clears _processingJobId so the queue can move on without waiting
// for an in-flight waitForResult to resolve. Safe: tick()'s finally block
// will set _processingJobId = null again (no-op) and re-schedule tick().
export function forceRelease(jobId) {
  if (_processingJobId !== jobId) return false;
  log(`[queue] force-releasing stuck job ${jobId}`);
  _processingJobId = null;
  setTimeout(tick, 300);
  return true;
}

// Returns today's jobs plus any non-terminal jobs from previous days (carry-over),
// falling back to the most recent non-empty file when today has nothing at all.
export async function getTodayJobs() {
  const todayPath = todayFile();
  const today = await readLogFile(todayPath);

  // Collect pending/waiting/running jobs from previous days so they stay visible after midnight
  const carryOver = [];
  for (const [fp, jobs] of await allLogFiles()) {
    if (fp === todayPath) continue;
    carryOver.push(...jobs.filter(j => ['pending', 'waiting', 'running'].includes(j.status)));
  }

  if (today.length > 0 || carryOver.length > 0) return [...carryOver, ...today];

  // Fallback: nothing today and no active carry-over — show most recent historical file
  for (const [, jobs] of await allLogFiles()) {
    if (jobs.length > 0) return jobs;
  }
  return [];
}

// Returns all done jobs across all log files (for startup sync across midnight)
export async function getAllDoneJobs() {
  const results = [];
  for (const [, jobs] of await allLogFiles()) {
    results.push(...jobs.filter(j => j.status === 'done'));
  }
  return results;
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
  await withQueueLock(async () => {
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
  });

  const job = await nextEligible();
  if (job) {
    log(`[queue] startup: found pending job ${job.id}, starting poller`);
    startPoller();
  } else {
    log('[queue] startup: no pending jobs');
  }
}
