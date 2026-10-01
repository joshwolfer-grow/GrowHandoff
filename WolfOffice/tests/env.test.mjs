import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../lib/env.mjs';

const tmpFiles = [];

function writeTempEnv(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  tmpFiles.push(file);
  return file;
}

beforeEach(() => {
  vi.stubEnv('OFFICE_SUPABASE_URL', undefined);
  vi.stubEnv('OFFICE_SERVICE_KEY', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpFiles.length) {
    const f = tmpFiles.pop();
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

describe('loadEnv', () => {
  it('parses quoted and export-prefixed lines, handling CRLF', () => {
    const file = writeTempEnv(
      [
        'export OFFICE_SUPABASE_URL="https://example.supabase.co/"',
        "OFFICE_SERVICE_KEY='super-secret-key'",
      ].join('\r\n')
    );
    const env = loadEnv(file);
    expect(env.url).toBe('https://example.supabase.co');
    expect(env.key).toBe('super-secret-key');
  });

  it('throws when required keys are missing', () => {
    const file = writeTempEnv('SOME_OTHER_VAR=1\n');
    expect(() => loadEnv(file)).toThrow(/OFFICE_SUPABASE_URL/);
  });
});
