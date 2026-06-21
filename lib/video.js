import { spawn } from 'child_process';
import { mkdir, access, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export async function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'v:0',
      videoPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    proc.stdout.on('data', d => out += d);

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      try {
        const { streams: [s] } = JSON.parse(out);
        const [num, den] = s.r_frame_rate.split('/').map(Number);
        const fps = num / den;
        const totalFrames = s.nb_frames
          ? parseInt(s.nb_frames, 10)
          : Math.round(parseFloat(s.duration) * fps);
        resolve({ fps: Math.round(fps * 100) / 100, totalFrames });
      } catch {
        reject(new Error('Failed to parse ffprobe output'));
      }
    });

    proc.on('error', reject);
  });
}

// Extract a consecutive range of frames using timestamp-based fast seek.
// Output: <outputDir>/frame_<N>.jpg for each N in [startFrame, endFrame].
// fps is required for the seek calculation.
export async function extractFrameRange(videoPath, startFrame, endFrame, outputDir, fps) {
  await mkdir(outputDir, { recursive: true });

  const count = endFrame - startFrame + 1;

  // Skip if all files already on disk
  const cached = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      access(join(outputDir, `frame_${startFrame + i}.jpg`)).then(() => true).catch(() => false)
    )
  );
  if (cached.every(Boolean)) return;

  // Seek to the approximate start time — fast regardless of where in the video we are
  const seekTime = Math.max(0, startFrame / fps);

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-ss', String(seekTime),
      '-i', videoPath,
      '-vframes', String(count),
      '-q:v', '3',
      '-start_number', String(startFrame),
      join(outputDir, 'frame_%d.jpg')
    ], { stdio: 'ignore' });

    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    proc.on('error', reject);
  });
}

// Concatenate video files using ffmpeg concat demuxer (stream copy — fast, no re-encode).
// All inputs must have compatible codec/resolution (WAN2.1 output always will).
export async function concatVideos(inputPaths, outputPath) {
  const listPath = join(tmpdir(), `ms_concat_${Date.now()}.txt`);
  const listContent = inputPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(listPath, listContent);

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        outputPath,
      ], { stdio: 'ignore' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg concat exited ${code}`)));
      proc.on('error', reject);
    });
  } finally {
    await unlink(listPath).catch(() => {});
  }
}
