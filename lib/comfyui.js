import { readFile, writeFile } from 'fs/promises';
import { basename } from 'path';

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

export async function queuePrompt(workflow) {
  const res = await fetch(`${COMFYUI}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`ComfyUI queue error: ${JSON.stringify(data.error)}`);
  return data.prompt_id;
}

// Poll until done or timeout (default 10 min)
export async function waitForResult(promptId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const res     = await fetch(`${COMFYUI}/history/${promptId}`);
    const history = await res.json();
    const entry   = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI generation failed');
    if (entry.status?.completed) return entry.outputs;
  }
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
