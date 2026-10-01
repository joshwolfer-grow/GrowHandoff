const COMMANDS = new Set(['start', 'finish', 'blocked', 'beat']);
const ALLOWED_FLAGS = new Set(['run', 'ok', 'fail', 'status', 'data', 'tokens']);

export function parseArgs(argv) {
  const [cmd, agent, ...rest] = argv;
  if (!COMMANDS.has(cmd)) throw new Error(`unknown command: ${cmd}`);
  if (!agent) throw new Error('agent id required');
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (!ALLOWED_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { cmd, agent, flags };
}

export function buildEvent({ cmd, agent, flags }, newId = defaultId) {
  const kind = cmd === 'beat' ? 'heartbeat' : cmd;
  let run_id;
  if (cmd === 'start' || cmd === 'beat') {
    if (flags.run === true) throw new Error('--run needs a value');
    run_id = flags.run || newId();
  } else {
    if (flags.run === true) throw new Error('--run needs a value');
    run_id = flags.run;
  }
  if (typeof run_id !== 'string' || run_id.length === 0) throw new Error('--run required');
  if (flags.status === true) throw new Error('--status needs a value');
  const status = typeof flags.status === 'string' ? flags.status : '';
  if (cmd === 'blocked' && !status) throw new Error('--status required for blocked');
  let ok = null;
  if (cmd === 'finish') ok = !flags.fail;
  let tin = null, tout = null;
  if (typeof flags.tokens === 'string') {
    const parts = flags.tokens.split(',');
    if (parts.length !== 2 || !parts.every(p => /^-?\d+$/.test(p.trim()))) {
      throw new Error('--tokens must be in,out integers');
    }
    [tin, tout] = parts.map(n => parseInt(n.trim(), 10));
  } else if (flags.tokens !== undefined) {
    throw new Error('--tokens must be in,out integers');
  }
  const data = typeof flags.data === 'string' ? JSON.parse(flags.data) : {};
  return { agent_id: agent, run_id, kind, ok, status, data, tokens_in: tin, tokens_out: tout };
}

function defaultId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
