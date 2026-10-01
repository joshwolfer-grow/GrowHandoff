// Runner logic: pure decisions over the task rows. Tested in tests/runner.test.mjs.

// Oldest queued task first. 'waiting' tasks are not eligible until approved.
export function pickNext(tasks) {
  return tasks.filter(t => t.state === 'queued').sort((a, b) => (a.requested_at < b.requested_at ? -1 : 1))[0] || null;
}

// Running tasks past their timeout are marked failed so a stuck one cannot block the floor.
export function timedOut(tasks, now = Date.now()) {
  return tasks.filter(t => t.state === 'running' && t.started_at && now - new Date(t.started_at).getTime() > (t.timeout_seconds || 600) * 1000);
}

export function counts(tasks) {
  const c = { queued: 0, waiting: 0, running: 0, done: 0, failed: 0 };
  for (const t of tasks) if (t.state in c) c[t.state]++;
  return c;
}

// The last non-empty line of a command's output, trimmed to fit a status bubble.
export function lastLine(output) {
  const lines = String(output || '').split('\n').map(s => s.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 140);
}

export function statusLine(c) {
  const bits = [];
  if (c.queued) bits.push(`${c.queued} queued`);
  if (c.waiting) bits.push(`${c.waiting} waiting for approval`);
  if (c.running) bits.push(`${c.running} running`);
  return bits.length ? `Front desk: ${bits.join(', ')}` : 'Front desk: nothing waiting';
}
