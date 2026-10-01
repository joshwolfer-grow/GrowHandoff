const SIX_H = 6 * 3600 * 1000;
const MIN_STALE = 10 * 60 * 1000;
const RANK = { finish: 3, blocked: 2, start: 1, heartbeat: 0 };

// A duty window: { days: [0-6, Sunday=0], start: 'HH:MM', end: 'HH:MM' } in local time.
export function inWindow(win, now = Date.now()) {
  if (!win) return true;
  const d = new Date(now);
  if (win.days && !win.days.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = (win.start || '00:00').split(':').map(Number), [eh, em] = (win.end || '23:59').split(':').map(Number);
  return mins >= sh * 60 + sm && mins <= eh * 60 + em;
}

export function deriveStatus(agent, events, now = Date.now()) {
  const mine = events.filter(e => e.agent_id === agent.id)
    .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || RANK[b.kind] - RANK[a.kind]);
  const newest = mine[0];
  const history = mine.filter(e => e.kind === 'finish').slice(0, 7).map(e => !!e.ok).reverse();
  const bubble = (newest && newest.status) || '';
  const age = newest ? now - new Date(newest.created_at).getTime() : Infinity;
  const staleAfter = agent.cadence_seconds ? Math.max(agent.cadence_seconds * 2000, MIN_STALE) : null;

  let state = 'idle';
  if (newest && newest.kind === 'start' && age < SIX_H) state = 'working';
  else if (newest && newest.kind === 'blocked') state = 'blocked';
  else if (newest && newest.kind === 'finish' && newest.ok === false) state = 'failed';
  else if (staleAfter !== null && age > staleAfter) state = inWindow(agent.duty, now) ? 'stale' : 'offduty';

  return { state, bubble, history, lastAt: newest ? newest.created_at : null };
}
