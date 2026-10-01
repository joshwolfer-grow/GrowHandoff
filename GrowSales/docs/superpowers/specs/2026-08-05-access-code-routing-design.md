# Access-code routing

**Date:** 2026-08-05
**Status:** approved, in implementation

## The idea

One URL for the whole company. Each person gets their own access code, and the
code decides which of the three existing surfaces the app opens into and whose
numbers it shows. No accounts, no passwords, no per-person links to generate.

Mass-email the link plus each person's code, they save it to the homescreen, done.

## What already exists

Three surfaces, currently selected by URL parameter:

| Surface | Trigger today | Code |
|---|---|---|
| Rep — own card + deals, no chrome | `?rep=Name` | `index.html:13843` |
| Manager — team-scoped dashboard | `?share=Name` / `?mgr=Name` | `index.html:1652` |
| Corporate — everything | no param + passcode | `index.html:19100` |

An access-code table already lives in `report_config.__corp_users__` with an
add/disable/remove screen at Admin › Access (`index.html:19209`). Today the code
only *unlocks* corporate. This work makes it *route*.

## Scope

**In scope:** routing, revocation, audit, per-role content config.

**Explicitly out of scope: data privacy.** `fetchLiveData` (`index.html:1375`)
pulls every table unconditionally with no role awareness — all deals, knocking,
leaderboard, and ~30 more. Every visitor's browser downloads the whole company's
data before anything decides what to render. A rep on `?rep=Chris` already has
all of it in memory; the rep view just doesn't draw it. The existing comment at
`index.html:13844` says as much: *"this is a visual scope only."*

Access codes decide **what opens**, not **what is reachable**. This does not make
that worse, and it does not fix it. The fix is a server-scoped payload endpoint
(`SUPABASE_SERVICE_KEY` is already available to `api/` functions — see
`api/send-push.js:6`), specified as a possible follow-on below. Codes are shaped
as tokens so that work composes rather than replaces.

## Decisions

| Question | Decision |
|---|---|
| Roles | `rep`, `manager`, `corporate` — exactly the three surfaces that exist |
| Issuance | auto-minted from the weekly roster paste; corporate added by hand |
| Sessions | rep/manager never expire; corporate re-prompts at 30 days |
| Existing links | keep working indefinitely |
| Storage | `access_codes` table, RLS-denied to anon, reached via `security definer` RPCs |
| Content control | configurable per role, not per person |
| Code format | 8 chars, alphabet excluding `0 O 1 I l` |

### Why 8 characters

The current generator is 6 numeric digits (`index.html:19213`) — a million-key
space with no rate limiting behind it. Once `redeem_access_code` is a public RPC
it becomes a clean brute-force target. 8 unambiguous alphanumerics makes guessing
pointless and still reads off an email onto a phone keypad without confusion.

## Architecture

### 1. Table

`access_codes`:

| column | type | notes |
|---|---|---|
| `code` | text PK | 8 chars, unambiguous alphabet |
| `name` | text | roster name as minted; for rep/manager this **is** the scope |
| `role` | text | `rep` \| `manager` \| `corporate` |
| `active` | boolean | default true |
| `added` | timestamptz | default now() |
| `seen` | timestamptz | stamped on redeem |
| `source` | text | `roster` \| `manual` |

There is no separate `subject` column. `name` is who the person is, and for rep
and manager it doubles as what they can see. Corporate ignores it for scoping.

RLS enabled with **no anon policies** — the table is unreachable except through
the functions below.

### 2. Functions (all `security definer`)

- `redeem_access_code(p_code)` → `{name, role}` for an active code, else zero
  rows. Stamps `seen`. The only function callable without a corporate code.
- `sync_roster_codes(p_admin_code, p_managers[], p_reps[])` → mints codes for
  names that don't have one. Called from the existing roster save.
- `list_access_codes(p_admin_code)` → full list, for Admin › Access.
- `upsert_access_code(p_admin_code, p_name, p_role, p_code)`
- `set_access_code_active(p_admin_code, p_code, p_active)`
- `delete_access_code(p_admin_code, p_code)`

Every function except `redeem` requires a valid corporate code, so enumeration is
gated behind corporate rather than open to anon.

### 3. Resolution order on load

1. `?rep=` / `?share=` / `?mgr=` / `?training=` / `?snapshot=` present → today's
   behavior exactly, no gate. Nothing existing changes.
2. Otherwise read session `growAccess = {code, name, role, at}` **synchronously**
   from localStorage and publish `window.__ACCESS = {name, role}`.
3. The `SCOPING` block (`index.html:1652`) reads `__ACCESS` as one more fallback
   source alongside the existing param and localStorage sources.
4. Asynchronously, re-`redeem` the stored code to honor revocation.
5. No valid session → show the gate. On successful redeem, store and **reload**.

### 4. Why reload instead of async routing

Lines 1652–15897 are all inside `bootDashboard` (`index.html:1470`), which runs
only after `fetchLiveData` resolves. But the gate currently fires at parse time
from `index.html:20271`. Threading async identity resolution between those two
means restructuring boot.

Instead: on successful redeem, store the session and `location.reload()`. The
reloaded page reads the session synchronously before `SCOPING` runs, so ordering
is trivially correct. This costs one reload per device, ever.

### 5. Role → surface mapping

Each role sets state the app already understands, which is why the diff stays small:

- `rep` → `SHARE_REP = name`, reusing `index.html:13843` untouched
- `manager` → `VIEW = name` with `SHARE_MGR` semantics (picker hidden)
- `corporate` → `VIEW = 'Corporate'`, picker visible

`growShareMgr` (`index.html:1664`) stays — it keeps already-installed manager
homescreen icons working. It becomes removable once param links are retired.

### 6. Fail-closed on unknown

The "require access code" flag is fetched async, so on a first-ever visit we
don't yet know whether gating is on. Default to **showing the gate** and remove it
if the fetched flag says gating is off. Unknown state must never flash company
data. The flag is cached in localStorage so this resolves instantly on repeat
visits.

### 7. Sessions and offline

Deliberate asymmetry, because reps knock in bad signal:

- **No cached session + RPC unreachable** → fail closed. "Can't verify right now."
- **Cached session + RPC unreachable** → fail open. They keep working offline.

Revocation therefore takes effect on the next load **with connectivity**, not
instantly. That is the honest trade for a PWA that has to work in a basement.

### 8. Per-role content config

One `report_config` row, `__surface_config__` — same pattern as `__corp_users__`
and `__roster_current__`, so no new table:

```json
{ "rep":     { "tabs": ["overview", "deals", "bria"] },
  "manager": { "tabs": ["..."] } }
```

Two touch points, both filters over lists that already exist:

- Rep surface filters `_RSTABS` (`index.html:14301`). The existing auto-hide of
  Deal check when a rep has no flags (`index.html:14479`) stays and stacks on
  top — config decides if a tab is *available*, data decides if it's *shown*.
- Manager surface filters the tab bar in `applyCoachTabs` (`index.html:4779`).

Corporate is not configurable — locking yourself out of your own tabs is a
footgun with no upside.

Guardrails:

- **Never allow an empty tab list.** The last remaining checkbox stays disabled.
- Config is a filter, not a boundary. Hiding a tab hides the tab; the data is
  still in the page.

### 9. Admin › Access rewrite

The current screen renders one flat row per person (`index.html:19237`) — fine
for twelve, unusable for 150+. Becomes:

- Grouped by role; reps collapsed behind a count
- Search box
- Per row: code, active toggle, remove, last seen
- **Bulk CSV export of name + code**, for mail merge. Without this, "mass send it
  in an email" means 150 copy-pastes.
- **"Require access code" master switch**, replacing the current
  `if(!users.length)` inference at `index.html:19199` — which would otherwise arm
  the gate for the whole company the first time a roster saved, possibly before
  anyone had their code.

### 10. Migration

- Existing `__corp_users__` records copy to `access_codes` as `role='corporate'`,
  **keeping their current codes** so nobody has to learn a new one.
- Existing `growCorpAuth` sessions are read and honored as valid corporate
  sessions, so current corporate users are not signed out by the deploy.
- The master switch ships **off**.
- Param links keep working indefinitely.

## Error handling

| Case | Behavior |
|---|---|
| Unknown or inactive code | "That code is not active." (existing copy) |
| Valid code, name doesn't resolve | Run `growMakeRepMatcher`; if it still misses, land on the existing "couldn't find stats" screen (`index.html:13870`), not a blank page |
| Mint collision | Regenerate |
| Empty tab config | Prevented in UI; treated as "all tabs" if it somehow occurs |
| RPC unreachable | Per §7 |

The name-drift case is not hypothetical. `growMakeRepMatcher` and
`_repLinkMatchSafe` (`index.html:9756`) exist because Sequifi says "Christopher
Lagrange" while the deals feed says "Chris Lagrange", and `index.html:13863`
exists to keep emailed links from dead-ending on it. Codes minted from roster
names inherit the same problem, so resolution happens **at redeem time through
the existing matcher**, not by cleaning names first.

## Verification

`package.json` has no test script and there is no test framework in the repo, so
there is no suite to extend. Standing up a real harness for the app is separate
work, scoped on its own.

### Automated — done

`scripts/test-access-codes.mjs`, **47 passed, 0 failed, 1 skipped** against the
live project. Deliberately anon-key-only: a test running as `service_role` would
prove nothing about whether a rep can reach the table, which is the entire point
of the RLS + security-definer design. Everything it creates is named `ztest_*` and
removed afterward.

Covers: table sealed to anon (select / insert / privilege-escalating patch),
helpers unreachable, redeem valid / unknown / empty / case-sensitivity, `seen`
stamping, mint idempotency, the both-lists-mints-once rule, blank and null and
padded roster names, code format, admin-gating on all five privileged functions
plus proof the rejected calls had no side effect, upsert conflicts and re-add
behavior, revoke-then-redeem, and list ordering.

**It caught a real bug.** The first migration revoked the private helpers from
`anon` but not from `PUBLIC`, and Postgres grants `EXECUTE` to `PUBLIC` by default
— so all three stayed callable. `_is_corp_admin` was the serious one: it answers
"is this a corporate code?" for any string, a brute-force oracle against the codes
that matter most. Fixed in `access_codes_seal_helpers`; a follow-up migration also
dropped the `authenticated` grants, since the app has no Supabase Auth.

**One assertion is not automated.** The last-active-corporate-code guard only
means anything when exactly one such code exists, and the live database has more,
so the suite reports a skip rather than a false pass. Verifying it properly needs
deleting production rows, so it stands as reviewed-by-inspection in
`set_access_code_active` and `delete_access_code`. It is exercised for real the
first time a branch or fresh database runs the suite.

### Manual checklist — not yet run

All three surfaces open correctly; corporate 30-day expiry; rep/manager no expiry;
offline with a cached session still works; offline without a session fails closed;
an already-installed homescreen icon on a param link still works; a manager's
bare-URL homescreen icon (`growShareMgr`, no param) still opens their own view
without a gate; unknown-flag state shows no data flash.

## Note: a pre-existing bug fixed in passing

`esc()` and `escapeCsv()` are declared **inside** `bootDashboard`, but the nav and
admin script block sits outside it. Every `esc()` call over there — 20 of them,
including the old Access screen — was throwing `ReferenceError: esc is not
defined` and taking the whole render down with it. Confirmed live in the browser
against the pre-change code, so Admin › Access was rendering nothing at all.

Fixed by declaring both at the top level of the first script block, where they are
genuinely global. The copies inside `bootDashboard` still shadow them and behave
identically, so nothing that already worked changes.

## Deployment state

- Migrations applied to `cmkfohwbejcztctrpdnt`: `access_codes_routing`,
  `access_codes_seal_helpers`, `access_codes_drop_authenticated_grants`.
- One pre-existing corporate code migrated across, keeping its original value
  (5 characters — old codes were shorter than the new 8-char format; deliberately
  not rewritten, so nobody has to relearn theirs).
- `__surface_config__` does not exist yet, so `require_code` is unset and **the
  gate is off**. Nothing has changed for any user.
- Turning it on is one button in Admin › Access, and it refuses to turn on unless
  an active corporate code exists.

## Unrelated findings, not addressed

The Supabase security linter also reports, all pre-existing and outside this work:

- `public.push_subscriptions` has RLS disabled while being exposed to PostgREST
  (**ERROR** level)
- `public.match_doc_chunks` has a mutable `search_path`
- the `vector` extension is installed in the `public` schema

## Possible follow-on: scoped payload

Not part of this work. Recorded so the token shape isn't accidental.

The browser sends its access code to `/api/payload`; the server validates it,
filters by role, returns only that person's slice. The anon key stops shipping in
the page. Roughly 41 `sbFetch` call sites (`index.html:764`), best staged —
`deals` and `knocking` first, config tables last. Needs care around PWA offline
caching, which currently assumes a full local payload.
