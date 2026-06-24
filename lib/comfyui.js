import { readFile, writeFile } from 'fs/promises';
import { basename } from 'path';
import { log, inlineLog } from './term.js';

const COMFYUI = process.env.COMFYUI_SERVER || 'http://127.0.0.1:8188';

export async function uploadImage(filePath) {
  const buf  = await readFile(filePath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('image', blob, basename(filePath));
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res  = await fetch(`${COMFYUI}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function uploadVideo(filePath) {
  const buf  = await readFile(filePath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('image', blob, basename(filePath));   // VHS accepts videos via /upload/image
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res  = await fetch(`${COMFYUI}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// Returns true if the promptId is still in ComfyUI's queue or history (i.e. re-attachable)
export async function checkPromptAlive(promptId) {
  try {
    const qRes  = await fetch(`${COMFYUI}/queue`, { signal: AbortSignal.timeout(4000) });
    const qData = await qRes.json();
    const active = [
      ...(qData.queue_running ?? []).map(e => e[1]),
      ...(qData.queue_pending ?? []).map(e => e[1]),
    ];
    if (active.includes(promptId)) return true;
    // Also check history — only re-attach if it completed successfully (not errored/interrupted)
    const hRes  = await fetch(`${COMFYUI}/history/${promptId}`, { signal: AbortSignal.timeout(4000) });
    const hData = await hRes.json();
    const entry = hData[promptId];
    if (!entry) return false;
    if (entry.status?.status_str === 'error') return false;
    return !!entry.status?.completed;
  } catch {
    return false;
  }
}

export async function queuePrompt(workflow) {
  log(`[comfyui] submitting prompt to ${COMFYUI}/prompt`);
  const res = await fetch(`${COMFYUI}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`ComfyUI queue error: ${JSON.stringify(data.error)}`);
  log(`[comfyui] prompt queued, id=${data.prompt_id}`);
  return data.prompt_id;
}

// Poll until done or timeout (default 6 hours).
// Downtime (consecutive fetch errors) does not count against the deadline.
export async function waitForResult(promptId, timeoutMs = 6 * 60 * 60 * 1000) {
  log(`[comfyui] waiting for prompt ${promptId}`);
  let pollCount = 0;
  let consecutiveErrors = 0;
  let downtime = 0;          // ms spent unreachable — excluded from timeout
  let downStart = null;
  const start = Date.now();

  while (true) {
    const elapsed = Date.now() - start - downtime - (downStart ? Date.now() - downStart : 0);
    if (elapsed >= timeoutMs) break;

    const backoff = consecutiveErrors === 0 ? 3_000
      : Math.min(30_000, 3_000 * Math.pow(2, consecutiveErrors - 1));
    await new Promise(r => setTimeout(r, backoff));
    pollCount++;

    try {
      const res     = await fetch(`${COMFYUI}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
      const history = await res.json();

      if (consecutiveErrors > 0) {
        if (downStart) { downtime += Date.now() - downStart; downStart = null; }
        log(`[comfyui] ComfyUI back after ${consecutiveErrors} failed poll(s)`);
        consecutiveErrors = 0;
      }

      const entry = history[promptId];
      if (!entry) {
        // After a grace period, verify the prompt still exists in ComfyUI's queue.
        // If it's gone from both history AND queue, ComfyUI restarted and lost it.
        if (pollCount >= 3) {
          try {
            const qRes  = await fetch(`${COMFYUI}/queue`, { signal: AbortSignal.timeout(4000) });
            const qData = await qRes.json();
            const active = [
              ...(qData.queue_running ?? []).map(e => e[1]),
              ...(qData.queue_pending ?? []).map(e => e[1]),
            ];
            if (!active.includes(promptId)) {
              log(`[comfyui] prompt ${promptId} not in history or queue — ComfyUI likely restarted`);
              throw new Error('ComfyUI restarted — prompt lost');
            }
          } catch (err) {
            if (err.message === 'ComfyUI restarted — prompt lost') throw err;
            // Queue fetch failed — treat as downtime, don't throw
          }
        }
        inlineLog(`[comfyui] poll #${pollCount} — not in history yet`);
        continue;
      }
      if (entry.status?.status_str === 'error') {
        log(`[comfyui] poll #${pollCount} — ComfyUI reported error`);
        throw new Error('ComfyUI generation failed');
      }
      if (entry.status?.completed) {
        log(`[comfyui] prompt ${promptId} completed after ${pollCount} polls`);
        return entry.outputs;
      }
      inlineLog(`[comfyui] poll #${pollCount} — status=${entry.status?.status_str}`);
    } catch (err) {
      if (err.message === 'ComfyUI generation failed') throw err;
      if (consecutiveErrors === 0) downStart = Date.now();
      consecutiveErrors++;
      log(`[comfyui] poll #${pollCount} fetch error (${consecutiveErrors} consecutive): ${err.message}`);
    }
  }
  log(`[comfyui] prompt ${promptId} timed out after ${pollCount} polls`);
  throw new Error('Generation timed out');
}

// Download a ComfyUI output file to a local path
export async function downloadOutput(filename, subfolder, destPath) {
  const params = new URLSearchParams({ filename, type: 'output' });
  if (subfolder) params.set('subfolder', subfolder);
  const res = await fetch(`${COMFYUI}/view?${params}`);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  await writeFile(destPath, Buffer.from(buf));
}
