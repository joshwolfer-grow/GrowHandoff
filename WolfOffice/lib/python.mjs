// lib/python.mjs — which python3 the Grow scripts run under.
// GROW_PYTHON (or LEADDESK_PYTHON) wins; otherwise plain `python3` from PATH. The old
// python.org 3.10 framework build is only added to PATH as a fallback when it exists.
import fs from 'node:fs';
import path from 'node:path';

const LEGACY = '/Library/Frameworks/Python.framework/Versions/3.10/bin';

export const PYTHON = process.env.GROW_PYTHON || process.env.LEADDESK_PYTHON || 'python3';

// Extra PATH entries so `python3` resolves under launchd's bare environment.
export function pythonDirs() {
  const dirs = [];
  if (PYTHON.includes('/')) dirs.push(path.dirname(PYTHON));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (fs.existsSync(LEGACY)) dirs.push(LEGACY);
  return dirs;
}
