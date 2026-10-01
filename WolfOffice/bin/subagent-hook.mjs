#!/usr/bin/env node
// bin/subagent-hook.mjs start|stop  — maps Claude Code subagents to office agents
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MAP = { 'isp-leads': 'courier' };            // agent_type -> office agent id
const phase = process.argv[2];
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input || '{}');
    const office = MAP[j.agent_type];
    if (!office) return;
    const log = path.join(os.homedir(), 'bin', 'office-log');
    const run = `cc-${j.agent_id}`;
    if (phase === 'start') execFileSync(log, ['start', office, '--run', run]);
    else execFileSync(log, ['finish', office, '--run', run, '--ok', '--status', 'Claude run finished']);
  } catch {}
});
