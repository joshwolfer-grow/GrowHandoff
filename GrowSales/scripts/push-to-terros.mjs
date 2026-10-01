#!/usr/bin/env node
// Upload a Terros-format CSV to Terros and report how the import went.
//
//   node scripts/push-to-terros.mjs <terros-format.csv> [--name "label"] [--cleanup Import.xxx]
//
// Mirrors the UI settings the user confirmed:
//   entity=Account, disableGeocoding=true (trust our pins),
//   addMissingUsers=false, createCustomLocations=true
//
// Reads TERROS_API_KEY from ~/.terros.env or the environment.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://api.terros.com'
const SETTINGS = {
  entity: 'Account',
  disableGeocoding: true,   // "Skip address lookup" — use the lat/lng in the CSV
  addMissingUsers: false,
  createCustomLocations: true
}

function loadKey () {
  if (process.env.TERROS_API_KEY) return process.env.TERROS_API_KEY
  const f = join(homedir(), '.terros.env')
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^TERROS_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error('No TERROS_API_KEY in env or ~/.terros.env')
}

const KEY = loadKey()
const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- cleanup mode: undo a previous import ----
const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null }

if (flag('cleanup')) {
  const id = flag('cleanup')
  console.log(`Rolling back ${id}...`)
  const r = await api('/import/cleanup', { entity: 'Account', importId: id, fullRun: true })
  console.log('Cleanup response:', JSON.stringify(r))
  process.exit(0)
}

// ---- upload mode ----
const file = argv.find(a => !a.startsWith('--'))
if (!file || !existsSync(file)) { console.error('Provide a Terros-format CSV path'); process.exit(1) }

const csv = readFileSync(file, 'utf8')
const rowCount = csv.trim().split('\n').length - 1
const name = flag('name') || `growsales import (${rowCount} rows)`

console.log(`\nFile:     ${file}`)
console.log(`Rows:     ${rowCount}`)
console.log(`Settings: entity=Account, disableGeocoding=true (trust CSV pins), addMissingUsers=false, createCustomLocations=true`)
// Accounts must be attached to a workflow or they won't appear in the
// Accounts list/map at all. Resolve it live rather than hardcoding.
const wfList = await api('/workflow/list', {})
const workflows = wfList.workflows || []
const wanted = flag('workflow')
const wf = wanted
  ? workflows.find(w => w.workflowId === wanted || (w.name || '').trim() === wanted.trim())
  : workflows[0]
if (!wf) { console.error('No workflow found; accounts would be invisible. Aborting.'); process.exit(1) }
if (workflows.length > 1 && !wanted) {
  console.log(`Note: ${workflows.length} workflows exist; using "${(wf.name || '').trim()}". Override with --workflow.`)
}
console.log(`Workflow: ${(wf.name || '').trim()} (${wf.workflowId})`)

console.log(`\n1/3  Creating import job...`)
const add = await api('/import/add', { ...SETTINGS, name, workflowId: wf.workflowId })
const importId = add.importData.importId
console.log(`     importId = ${importId}`)

console.log(`2/3  Uploading CSV to S3...`)
const put = await fetch(add.url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csv })
if (!put.ok) throw new Error(`S3 upload failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`)
console.log(`     uploaded (${csv.length.toLocaleString()} bytes)`)

console.log(`3/3  Processing`)
let log, done = false
const TERMINAL = /complet|done|finish|fail|error/i
for (let i = 0; i < 60 && !done; i++) {
  await sleep(2000)
  const r = await api('/import/get', { importId })
  log = r.log || r.importData || r
  const status = log.importStatus || log.status || 'unknown'
  process.stdout.write(`\r     status: ${status}   successes: ${log.successes ?? '?'}  errors: ${log.errors ?? '?'}   `)
  // terminal when status looks done, or counts cover all rows
  if (TERMINAL.test(status) && status.toLowerCase() !== 'new') done = true
  if ((log.successes ?? 0) + (log.errors ?? 0) >= rowCount && rowCount > 0) done = true
}
console.log('\n')

// ---- report ----
const ok = log.successes ?? 0
const bad = log.errors ?? 0
console.log('='.repeat(50))
console.log(`Import ${importId}`)
console.log(`  created:  ${ok}/${rowCount}`)
console.log(`  errors:   ${bad}`)
console.log('='.repeat(50))

if (bad > 0) {
  const errs = await api('/import/errors', { importId })
  const recs = errs.records || []
  console.log(`\nFirst ${Math.min(recs.length, 10)} error rows:`)
  for (const rec of recs.slice(0, 10)) {
    const msg = rec.message || rec.error || rec.reason || JSON.stringify(rec).slice(0, 120)
    console.log(`  - ${msg}`)
  }
}
console.log(`\nUndo this entire import if needed:\n  node scripts/push-to-terros.mjs --cleanup ${importId}\n`)
