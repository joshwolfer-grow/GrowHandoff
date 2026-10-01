// workers/runner/menu.mjs — the only tasks a Runner can execute. The queue names a
// kind and an agent; the command text always comes from here and site/help.js,
// never from the request. risk 'approve' parks the task as 'waiting' until someone
// taps Approve on the Runner's card.
import { FACTS } from '../../site/help.js';

export const FLOORS = ['grow'];

export const MENU = {
  run:     { label: 'Run the job now',      risk: 'safe',    timeout: 1800, viaDesk: true,
             command: (f) => f.run || null },
  check:   { label: 'Check the launchd job', risk: 'safe',   timeout: 60,
             command: (f) => f.label ? `launchctl list | grep ${f.label} || echo "not loaded"` : null },
  restart: { label: 'Restart the job',       risk: 'safe',   timeout: 60,
             command: (f) => f.label ? `launchctl unload ~/Library/LaunchAgents/${f.label}.plist; launchctl load ~/Library/LaunchAgents/${f.label}.plist && echo restarted` : null },
  log:     { label: 'Show the log',          risk: 'safe',   timeout: 60,
             command: (f) => f.log ? `tail -40 "${f.log}"` : null },
  fix:     { label: 'Run the fix command',   risk: 'approve', timeout: 900, viaDesk: true,
             command: (f, args) => (f.failCommands && args && f.failCommands[String(args.code)]) || null },
};

// Resolve a queued task into something executable, or say why not.
export function resolve(task, facts = FACTS) {
  const m = MENU[task.kind];
  if (!m) return { error: `unknown task kind "${task.kind}"` };
  const f = facts[task.agent_id];
  if (!f) return { error: `no facts for worker "${task.agent_id}"` };
  const cmd = m.command(f, task.args || {});
  if (!cmd) return { error: `${m.label} is not available for ${task.agent_id}` };
  return { cmd, timeout: task.timeout_seconds || m.timeout, viaDesk: !!m.viaDesk, label: m.label };
}

// What the page or a worker may enqueue: validated shape and the state it starts in.
export function newTask({ kind, agent, args, note, requestedBy }, agents, facts = FACTS) {
  const m = MENU[kind];
  if (!m) return { error: 'unknown task kind' };
  if (!/^[a-z0-9_-]{1,40}$/.test(String(agent || ''))) return { error: 'bad agent' };
  const a = agents.find(x => x.id === agent);
  if (!a) return { error: 'unknown worker' };
  const check = resolve({ kind, agent_id: agent, args }, facts);
  if (check.error) return { error: check.error };
  return {
    task: {
      agent_id: agent, floor: a.floor, kind, args: args && typeof args === 'object' ? args : {},
      state: m.risk === 'approve' ? 'waiting' : 'queued',
      requested_by: String(requestedBy || 'page').slice(0, 40), note: note ? String(note).slice(0, 300) : null,
      timeout_seconds: m.timeout,
    },
  };
}
