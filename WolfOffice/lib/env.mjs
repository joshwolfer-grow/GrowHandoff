import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0], last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function loadEnv(file) {
  const target = file || path.join(ROOT, '.env');
  const out = { ...process.env };
  if (fs.existsSync(target)) {
    for (const rawLine of fs.readFileSync(target, 'utf8').split(/\r\n|\n/)) {
      const m = rawLine.match(LINE_RE);
      if (m && out[m[1]] === undefined) out[m[1]] = stripQuotes(m[2]);
    }
  }
  const url = out.OFFICE_SUPABASE_URL, key = out.OFFICE_SERVICE_KEY;
  if (!url || !key) throw new Error('OFFICE_SUPABASE_URL and OFFICE_SERVICE_KEY must be set in WolfOffice/.env (see .env.example)');
  return { url: url.replace(/\/$/, ''), key };
}

/** A single value from the process env or WolfOffice/.env, for optional integrations. */
export function envValue(name, file) {
  if (process.env[name] !== undefined) return process.env[name];
  const target = file || path.join(ROOT, '.env');
  if (!fs.existsSync(target)) return undefined;
  for (const rawLine of fs.readFileSync(target, 'utf8').split(/\r\n|\n/)) {
    const m = rawLine.match(LINE_RE);
    if (m && m[1] === name) return stripQuotes(m[2]);
  }
  return undefined;
}
