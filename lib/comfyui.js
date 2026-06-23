import { readFile, writeFile } from 'fs/promises';
import { basename } from 'path';
import { log, inlineLog } from './term.js';

const COMFYUI = process.env.COMFYUI_SERVER || 'http://192.168.0.110:8188';

export async function uploadImage(filePath) {
  const buf  = await readFile(filePath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('image', blob, basename(filePath));
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res  = await fetch(`${COMFYUI}/upload/image`, { method: 'POST', body: form });
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
  const res  = await fetch(`${COMFYUI}/upload/image`, { method: 'POST', body: form });
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
    // Also check history — if it completed but server restarted before downloading
    const hRes  = await fetch(`${COMFYUI}/history/${promptId}`, { signal: AbortSignal.timeout(4000) });
    const hData = await hRes.json();
    return !!hData[promptId];
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

// Poll until done or timeout (default 10 min)
export async function waitForResult(promptId, timeoutMs = 600_000) {
  log(`[comfyui] waiting for prompt ${promptId}`);
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    pollCount++;
    try {
      const res     = await fetch(`${COMFYUI}/history/${promptId}`);
      const history = await res.json();
      const entry   = history[promptId];
      if (!entry) {
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
      log(`[comfyui] poll #${pollCount} fetch error: ${err.message}`);
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
