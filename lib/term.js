// Shared terminal helpers for in-place (rewritable) lines and permanent logs.
// inlineLog() rewrites the current line; log() commits it and prints normally.

let _inlineActive = false;
const _cols = () => process.stdout.columns || 100;

export function inlineLog(msg) {
  const line = `\r${msg}`;
  process.stdout.write(line.padEnd(_cols()));
  _inlineActive = true;
}

export function log(msg) {
  if (_inlineActive) {
    process.stdout.write('\n');
    _inlineActive = false;
  }
  console.log(msg);
}
