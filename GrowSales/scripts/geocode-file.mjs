#!/usr/bin/env node
// Geocode an address file via Geocodio v2 and report rooftop accuracy.
//
//   node scripts/geocode-file.mjs <input.csv> [--out result.csv] [--limit N] [--dry]
//
// Column mapping is auto-detected. Override with:
//   --full "Property Address"          single-column address
//   --number HouseNo --predir Dir --street StreetName --suffix St_Type \
//   --postdir PostDir --unit Apt --city City --state ST --zip ZipCode
//
// Reads GEOCODIO_API_KEY from ~/.geocodio.env or the environment.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BATCH = 1000 // rows per API call; API allows 10k, smaller gives progress
const API = 'https://api.geocod.io/v2/geocode'

// ---------- key ----------

function loadKey () {
  if (process.env.GEOCODIO_API_KEY) return process.env.GEOCODIO_API_KEY
  const envFile = join(homedir(), '.geocodio.env')
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^GEOCODIO_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error('No GEOCODIO_API_KEY found in env or ~/.geocodio.env')
}

// ---------- csv ----------

function parseCsv (text) {
  const rows = []
  let row = [], field = '', quoted = false
  const src = text.replace(/^﻿/, '') // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(v => v.trim()))
}

function toCsv (rows) {
  return rows.map(r => r.map(v => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n')
}

// ---------- column detection ----------

// Ordered patterns. First matching header wins for each role.
const PATTERNS = {
  full:     [/^(property\s*)?(full\s*)?address(\s*1)?$/i, /^site\s*address$/i, /^addr(ess)?_?1$/i, /^street\s*address$/i],
  number:   [/^(house|street|st)_?(no|num|number)$/i, /^number$/i, /^addr(ess)?_?num/i],
  predir:   [/^pre_?dir/i, /^dir(ection)?_?prefix$/i, /^prefix$/i, /^dir(ection)?$/i],
  street:   [/^street_?name$/i, /^street$/i, /^st_?name$/i, /^road$/i],
  suffix:   [/^(street|st)_?(type|suffix)$/i, /^suffix$/i, /^st_?desig/i],
  postdir:  [/^post_?dir/i, /^dir(ection)?_?suffix$/i, /^suffix_?dir/i],
  unit:     [/^(unit|apt|apartment|suite|ste)(_?(no|num|number))?$/i, /^addr(ess)?_?2$/i, /^sec(ondary)?_?(unit|addr)/i],
  city:     [/^city$/i, /^town$/i, /^municipality$/i, /^post_?office$/i],
  state:    [/^st$/i, /^state$/i, /^state_?(abbr|code|province)?$/i, /^province$/i],
  zip:      [/^zip(_?code)?$/i, /^postal_?code$/i, /^zip5$/i],
  status:   [/^status$/i, /^lead_?status$/i, /^disposition$/i]
}

function detectColumns (headers) {
  // Normalize "unit number" / "Zip Code" so space and underscore behave the same.
  const norm = headers.map(h => h.trim().replace(/\s+/g, '_'))
  const map = {}
  for (const [role, pats] of Object.entries(PATTERNS)) {
    for (const pat of pats) {
      const hit = norm.findIndex(h => pat.test(h))
      if (hit !== -1 && !Object.values(map).includes(hit)) { map[role] = hit; break }
    }
  }
  return map
}

// ---------- address assembly ----------

function buildAddress (row, map) {
  const get = role => (map[role] != null ? (row[map[role]] || '').trim() : '')

  let line1
  if (map.full != null && get('full')) {
    line1 = get('full')
  } else {
    line1 = [get('number'), get('predir'), get('street'), get('suffix'), get('postdir')]
      .filter(Boolean).join(' ')
  }

  const unit = get('unit')
  // Geocodio parses units fine, but a bare number needs a designator.
  if (unit) line1 += /^[a-z]/i.test(unit) ? ` ${unit}` : ` Unit ${unit}`

  const tail = [get('city'), [get('state'), get('zip')].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ')

  return [line1, tail].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim()
}

// ---------- geocoding ----------

class BatchForbidden extends Error {}

async function geocodeBatch (addresses, key) {
  const res = await fetch(`${API}?api_key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(addresses)
  })
  if (res.status === 403) throw new BatchForbidden(await res.text())
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Geocodio ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = await res.json()
  return json.results || []
}

// Free-tier fallback: batch POST is a paid feature, single GET is not.
async function geocodeSingle (address, key) {
  const url = `${API}?q=${encodeURIComponent(address)}&api_key=${encodeURIComponent(key)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocodio ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  return json.results?.[0] || null // results are ranked; [0] is the best match
}

async function geocodeSerial (addresses, key, onResult, concurrency = 8) {
  let next = 0, done = 0, errors = 0, firstError = null
  const workers = Array.from({ length: Math.min(concurrency, addresses.length) }, async () => {
    while (next < addresses.length) {
      const addr = addresses[next++]
      try {
        onResult(addr, await geocodeSingle(addr, key))
      } catch (e) {
        errors++
        firstError ||= e
        onResult(addr, null)
      }
      if (++done % 25 === 0 || done === addresses.length) {
        process.stdout.write(`\r  geocoding ${done}/${addresses.length}...   `)
      }
    }
  })
  await Promise.all(workers)
  process.stdout.write('\n')
  // A wall of API errors is a broken run, not a file full of bad addresses.
  if (errors) {
    console.error(`\n  ${errors}/${addresses.length} lookups errored. First error:\n  ${firstError.message}\n`)
    if (errors === addresses.length) {
      console.error('  Every lookup failed, so this is an API/account problem, not your data.')
      process.exit(1)
    }
  }
}

// ---------- main ----------

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 ? argv[i + 1] : null
}
const has = name => argv.includes(`--${name}`)

const input = argv.find(a => !a.startsWith('--') && (argv.indexOf(a) === 0 || !argv[argv.indexOf(a) - 1]?.startsWith('--')))
if (!input) {
  console.error('usage: node scripts/geocode-file.mjs <input.csv> [--out out.csv] [--limit N] [--dry]')
  process.exit(1)
}

const rows = parseCsv(readFileSync(input, 'utf8'))
const headers = rows[0]
let dataRows = rows.slice(1)

const limit = flag('limit') ? parseInt(flag('limit'), 10) : null
if (limit) dataRows = dataRows.slice(0, limit)

// auto-detect, then apply explicit overrides
const map = detectColumns(headers)
for (const role of Object.keys(PATTERNS)) {
  const override = flag(role === 'predir' ? 'predir' : role)
  if (override) {
    const i = headers.findIndex(h => h.trim().toLowerCase() === override.trim().toLowerCase())
    if (i === -1) { console.error(`Column not found: ${override}`); process.exit(1) }
    map[role] = i
  }
}

console.log(`\nFile: ${input}`)
console.log(`Rows: ${dataRows.length}  Columns: ${headers.length}\n`)
console.log('Detected mapping:')
for (const role of Object.keys(PATTERNS)) {
  if (map[role] != null) console.log(`  ${role.padEnd(8)} -> ${headers[map[role]]}`)
}
if (!Object.keys(map).length) {
  console.error('\nNo address columns detected. Headers were:\n  ' + headers.join('\n  '))
  process.exit(1)
}

const built = dataRows.map(r => buildAddress(r, map))
console.log('\nSample assembled addresses:')
built.slice(0, 5).forEach(a => console.log(`  ${a}`))

if (has('dry')) { console.log('\n(dry run, nothing sent)\n'); process.exit(0) }

// Dedupe: identical addresses cost identical lookups.
const unique = [...new Set(built.filter(Boolean))]
console.log(`\n${built.length} rows -> ${unique.length} unique addresses to look up`)
console.log(`Estimated cost: $${(unique.length / 1000).toFixed(2)} at $1/1k (free under 2,500/day)\n`)

const key = loadKey()
const found = new Map()

// Local cache: never pay for the same address twice across runs.
const cachePath = join(homedir(), '.geocodio-cache.json')
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {}
let fromCache = 0
const toFetch = []
for (const addr of unique) {
  if (cache[addr]) { found.set(addr, cache[addr]); fromCache++ } else toFetch.push(addr)
}
if (fromCache) console.log(`  ${fromCache} served from local cache, ${toFetch.length} to fetch`)

const record = (addr, best) => {
  if (best) { found.set(addr, best); cache[addr] = best }
}

try {
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const chunk = toFetch.slice(i, i + BATCH)
    process.stdout.write(`  geocoding ${i + 1}-${i + chunk.length} of ${toFetch.length}... `)
    const results = await geocodeBatch(chunk, key)
    results.forEach((entry, idx) => record(chunk[idx], entry.response?.results?.[0]))
    writeFileSync(cachePath, JSON.stringify(cache))
    console.log('ok')
  }
} catch (err) {
  if (!(err instanceof BatchForbidden)) throw err
  console.log('\n  Batch POST returned 403. Retrying with single calls, which have')
  console.log('  different plan requirements on some accounts.\n')
  await geocodeSerial(toFetch, key, record)
  writeFileSync(cachePath, JSON.stringify(cache))
}

// ---------- output ----------

// Three output modes:
//   --terros  emit the canonical Terros import schema (for raw source files)
//   default   fill existing latitude/longitude columns in place
//   --append  append our own columns, leaving the original untouched
const latCol = headers.findIndex(h => /^lat(itude)?$/i.test(h.trim()))
const lngCol = headers.findIndex(h => /^(lng|lon|long|longitude)$/i.test(h.trim()))
const terrosMode = has('terros')
const inPlace = !terrosMode && latCol !== -1 && lngCol !== -1 && !has('append')

// ---------- Terros schema + rep assignment ----------

const dataDir = join(process.cwd(), 'data')
const schemaPath = [join(dataDir, 'terros-schema.csv'),
  join(homedir(), 'Grow/GrowSales/data/terros-schema.csv')].find(existsSync)
const repsPath = [join(dataDir, 'terros-reps.json'),
  join(homedir(), 'Grow/GrowSales/data/terros-reps.json')].find(existsSync)

let terrosCols = [], assignCol = 'sourceId', repId = null

if (terrosMode) {
  if (!schemaPath) { console.error('Missing data/terros-schema.csv'); process.exit(1) }
  terrosCols = parseCsv(readFileSync(schemaPath, 'utf8'))[0]

  const repName = flag('rep')
  if (repName) {
    if (!repsPath) { console.error('Missing data/terros-reps.json'); process.exit(1) }
    const reps = JSON.parse(readFileSync(repsPath, 'utf8'))
    assignCol = reps._assignmentColumn || 'sourceId'
    const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const hit = Object.entries(reps.reps).find(([n]) => norm(n) === norm(repName))
    if (!hit) {
      console.error(`\nNo Terros ID for rep "${repName}".`)
      console.error('Known reps: ' + Object.keys(reps.reps).join(', '))
      console.error('Add them to data/terros-reps.json, or pass --set sourceId=<id> directly.\n')
      process.exit(1)
    }
    repId = hit[1]
    console.log(`\nAssigning to ${hit[0]} -> ${assignCol}=${repId}`)
  }
}

// --set col=value, repeatable, applied to every row
const overrides = {}
argv.forEach((a, i) => {
  if (a === '--set' && argv[i + 1]) {
    const eq = argv[i + 1].indexOf('=')
    if (eq > 0) overrides[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1)
  }
})

function terrosRow (row, hit, addr) {
  const get = role => (map[role] != null ? (row[map[role]] || '').trim() : '')
  // Prefer Geocodio's normalized components; they fix abbreviations and typos.
  const c = hit?.address_components
  const vals = {
    // formatted_street already includes the pre-directional; don't add it twice.
    street: c ? [c.number, c.formatted_street].filter(Boolean).join(' ')
      : (map.full != null && get('full') ? get('full')
        : [get('number'), get('predir'), get('street'), get('suffix')].filter(Boolean).join(' ')),
    city: c?.city || get('city'),
    state: c?.state_province || get('state'),
    zip: c?.postal_code || get('zip'),
    'unit number': get('unit'),
    latitude: hit ? hit.location.lat : '',
    longitude: hit ? hit.location.lng : '',
    stage: 'Lead',
    // Terros Account import requires a `status` header with a valid stage value.
    // These imports always land as "Lead" (per user); "New Lead" is not a valid
    // Terros stage. Valid set: Start, Lead, Unique Knock, Contact, Sold, Call
    // Back, Current Customer, Do Not Knock, No English, Not Home 1/2/3, Not
    // Interested, Vacant Home.
    status: 'Lead',
    ...(repId ? { [assignCol]: repId } : {}),
    ...overrides
  }
  return terrosCols.map(col => vals[col] ?? '')
}

const outCols = ['geocoded_address', 'geo_latitude', 'geo_longitude', 'geo_accuracy', 'geo_accuracy_type', 'geo_match_type', 'geo_source']
const out = [terrosMode ? [...terrosCols]
  : inPlace ? [...headers]
    : [...headers, '_assembled_address', ...outCols]]

const stats = { total: built.length, matched: 0, rooftop: 0, byType: {}, byMatch: {} }
const audit = [['address', 'latitude', 'longitude', 'accuracy', 'accuracy_type', 'match_type', 'source']]

dataRows.forEach((r, i) => {
  const addr = built[i]
  const hit = found.get(addr)
  if (hit) {
    stats.matched++
    const t = hit.accuracy_type || 'unknown'
    const m = hit.match_type || '-'
    stats.byType[t] = (stats.byType[t] || 0) + 1
    stats.byMatch[m] = (stats.byMatch[m] || 0) + 1
    if (t === 'rooftop') stats.rooftop++
    audit.push([addr, hit.location.lat, hit.location.lng, hit.accuracy, t, m, hit.source || ''])
    if (terrosMode) {
      const tr = terrosRow(r, hit, addr)
      // Terros rejects a row with no street (e.g. Geocodio "place" matches that
      // resolve to an area, not an address). Route those to failures instead.
      const streetIdx = terrosCols.indexOf('street')
      if (tr[streetIdx] && tr[streetIdx].trim()) out.push(tr)
      else { audit[audit.length - 1][4] = 'NO_STREET'; stats.matched-- }
    } else if (inPlace) {
      const filled = [...r]
      while (filled.length < headers.length) filled.push('')
      filled[latCol] = hit.location.lat
      filled[lngCol] = hit.location.lng
      out.push(filled)
    } else {
      out.push([...r, addr, hit.formatted_address, hit.location.lat, hit.location.lng,
        hit.accuracy, t, m, hit.source || ''])
    }
  } else {
    audit.push([addr, '', '', '', 'NO_MATCH', '', ''])
    if (terrosMode) {
      // Deliberately omitted: a lead with no coordinates would import to a
      // null island pin. It goes to the failures file for manual handling.
    } else if (inPlace) {
      const filled = [...r]
      while (filled.length < headers.length) filled.push('')
      filled[latCol] = ''
      filled[lngCol] = ''
      out.push(filled)
    } else {
      out.push([...r, addr, '', '', '', '', 'NO_MATCH', '', ''])
    }
  }
})

if (inPlace) console.log(`\nSchema preserved: filled "${headers[latCol]}" / "${headers[lngCol]}" in place`)

const outPath = flag('out') || input.replace(/\.csv$/i, '') + '.geocoded.csv'
writeFileSync(outPath, toCsv(out))

// Sidecar audit so accuracy is inspectable without polluting the import file.
const auditPath = outPath.replace(/\.csv$/i, '') + '.audit.csv'
writeFileSync(auditPath, toCsv(audit))

const failRows = audit.slice(1).filter(r => r[4] === 'NO_MATCH' || r[4] === 'NO_STREET')
if (failRows.length) {
  const failPath = outPath.replace(/\.csv$/i, '') + '.failures.csv'
  writeFileSync(failPath, toCsv([audit[0], ...failRows]))
  console.log(`\n${failRows.length} failures written to ${failPath}`)
}

const pct = n => `${((n / stats.total) * 100).toFixed(1)}%`
console.log(`\n${'='.repeat(52)}`)
console.log(`Matched:  ${stats.matched}/${stats.total}  (${pct(stats.matched)})`)
console.log(`ROOFTOP:  ${stats.rooftop}/${stats.total}  (${pct(stats.rooftop)})   <- pins on the house`)
console.log('\nAccuracy types:')
Object.entries(stats.byType).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${pct(v)}`))
console.log('\nMatch types (rooftop detail):')
Object.entries(stats.byMatch).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${pct(v)}`))
console.log(`${'='.repeat(52)}`)
console.log(`\nWrote ${outPath}\n`)
